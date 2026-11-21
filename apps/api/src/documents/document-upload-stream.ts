import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';
import Busboy from 'busboy';
import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { domainError } from '../common/domain-support.js';
import { HEAD_BYTES, sanitizeFileName } from './document-files.js';

/** A file part received into its own temporary directory (removed by the caller). */
export interface ReceivedFile {
  path: string;
  directory: string;
  sizeBytes: number;
  sha256: string;
  head: Buffer;
  fileName: string;
}

/** How long a failed upload waits for its temporary file handle to close before cleanup. */
const CLOSE_WAIT_MS = 5_000;

const interrupted = () =>
  new BadRequestException(
    domainError(
      400,
      'DOCUMENT_UPLOAD_INTERRUPTED',
      'The upload was interrupted or malformed; try again.',
    ),
  );
const invalid = (message: string) =>
  new BadRequestException(domainError(400, 'DOCUMENT_UPLOAD_INVALID', message));

/** The request is gone (destroyed before its body ended): nothing more will arrive. */
const gone = (source: Readable) => source.destroyed && !source.readableEnded;

/** Resolves once `output` has closed its file handle (or was never opened), bounded in time. */
function closed(output: WriteStream | null): Promise<void> {
  if (!output || output.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CLOSE_WAIT_MS);
    timer.unref();
    output.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Batch 9 — receives one multipart file part (field `file`) into a fresh temporary directory:
 * size, SHA-256 and head bytes as it streams, the size limit enforced by the parser.
 *
 * Lifecycle (final review): the directory exists before any part is accepted, so the
 * temporary file is opened synchronously when the part starts — never after the upload has
 * already failed. Every failure signal (request aborted, request closed before its end,
 * request or parser error, part or write error, missing/oversized/empty part) settles once:
 * the request is unpiped, the parser, the part and the write stream are destroyed, the write
 * stream's handle is awaited closed (bounded), and only then the directory is removed and the
 * error returned. Later signals are ignored. A valid multipart terminator is never required to
 * settle. On success the caller owns the directory and removes it.
 */
export async function receiveMultipartFile(
  request: { headers: IncomingHttpHeaders; stream: Readable },
  limit: number,
): Promise<ReceivedFile> {
  const source = request.stream;
  let parser: Busboy.Busboy;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        files: 1,
        fileSize: limit,
        fields: 0,
        parts: 1,
        headerPairs: 50,
      },
    });
  } catch {
    throw invalid('The upload is not valid multipart data.');
  }
  if (gone(source)) throw interrupted();
  const directory = await mkdtemp(join(tmpdir(), 'hrms-upload-'));
  try {
    return await receiveInto(directory, source, parser, limit);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function receiveInto(
  directory: string,
  source: Readable,
  parser: Busboy.Busboy,
  limit: number,
): Promise<ReceivedFile> {
  return new Promise<ReceivedFile>((resolve, reject) => {
    const path = join(directory, 'upload.bin');
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    let fileName = 'document';
    let part: Readable | null = null;
    let output: WriteStream | null = null;
    let written: Promise<void> | null = null;
    let settled = false;

    const onAborted = () => finish(interrupted());
    const onClose = () => {
      if (!source.readableEnded) finish(interrupted());
    };
    const onSourceError = () => finish(interrupted());

    function finish(error: unknown, value?: ReceivedFile) {
      if (settled) return;
      settled = true;
      source.off('aborted', onAborted);
      source.off('close', onClose);
      source.off('error', onSourceError);
      if (!error) {
        // Success: the file is complete and its handle closed before the caller reads it.
        void closed(output).then(() => resolve(value!));
        return;
      }
      source.unpipe(parser);
      part?.destroy();
      parser.destroy();
      output?.destroy();
      // A malformed body on a live connection: drain the rest so the error can be answered.
      if (!source.destroyed) source.resume();
      void closed(output).then(() =>
        reject(error instanceof HttpException ? error : interrupted()),
      );
    }

    // Errors of every stream are observed (never an unhandled 'error' event) and settle here.
    source.on('aborted', onAborted);
    source.on('close', onClose);
    source.on('error', onSourceError);
    parser.on('error', (error: unknown) => finish(error));

    parser.on('file', (field, file, info) => {
      file.on('error', () => undefined);
      if (settled || field !== 'file' || part) {
        file.resume();
        return;
      }
      part = file;
      fileName = sanitizeFileName(info.filename);
      // Opened synchronously, after the directory exists and while the upload is live.
      output = createWriteStream(path, { mode: 0o600, flags: 'wx' });
      output.on('error', () => undefined);
      file.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
        if (headLength < HEAD_BYTES) {
          head.push(chunk.subarray(0, HEAD_BYTES - headLength));
          headLength += Math.min(chunk.length, HEAD_BYTES - headLength);
        }
      });
      written = pipeline(file, output);
      written.catch((error: unknown) => finish(error));
    });

    parser.on('close', () => {
      if (!part || !written)
        return finish(invalid('Attach one file in the "file" field.'));
      const truncated = (part as unknown as { truncated?: boolean }).truncated;
      written.then(
        () => {
          // busboy marks a part cut at the size limit (read after the part ended, so an
          // early 'limit' event can never be missed).
          if (
            truncated ||
            (part as unknown as { truncated?: boolean }).truncated
          )
            return finish(
              new PayloadTooLargeException(
                domainError(
                  413 as 400,
                  'DOCUMENT_FILE_TOO_LARGE',
                  `Files may be at most ${limit} bytes.`,
                ),
              ),
            );
          if (size === 0)
            return finish(
              new BadRequestException(
                domainError(400, 'DOCUMENT_FILE_EMPTY', 'The file is empty.'),
              ),
            );
          finish(null, {
            path,
            directory,
            sizeBytes: size,
            sha256: hash.digest('hex'),
            head: Buffer.concat(head),
            fileName,
          });
        },
        (error: unknown) => finish(error),
      );
    });

    // The request may have gone while the directory was being created.
    if (gone(source)) return finish(interrupted());
    source.pipe(parser);
  });
}
