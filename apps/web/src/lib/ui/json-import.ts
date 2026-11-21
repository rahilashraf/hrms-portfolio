/**
 * Reads a pasted JSON import. Anything but a JSON array is refused with a message for the
 * field, so an import never silently sends an empty list.
 */
export function parseJsonArray(
  text: string,
): { ok: true; items: unknown[] } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: 'This is not valid JSON. Paste a JSON array, for example [ {…} ].',
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'Paste a JSON array ([ … ]), not a single value or object.' };
  }
  return { ok: true, items: parsed };
}
