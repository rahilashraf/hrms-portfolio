import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';

/**
 * Deterministic interleavings on committed data: a gate pauses a transaction at a chosen point
 * (and records its backend pid), so a test can run a competing operation and observe whether it
 * waits on the paused transaction (pg_blocking_pids) before letting it continue.
 */

/** A one-shot pause inside a transaction, recording the transaction's backend pid. */
export class Gate {
  armed = true;
  pid: number | undefined;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private reachedResolve!: () => void;
  readonly reached = new Promise<void>((resolve) => {
    this.reachedResolve = resolve;
  });
  open() {
    this.release();
  }
  async pass(client: { $queryRawUnsafe: <T>(query: string) => Promise<T> }) {
    if (!this.armed) return;
    this.armed = false;
    const [{ pid }] = await client.$queryRawUnsafe<Array<{ pid: number }>>(
      'SELECT pg_backend_pid() AS pid',
    );
    this.pid = pid;
    this.reachedResolve();
    await this.released;
  }
}

/**
 * Before the write: role assignment has read the user's status; the delegation check sits
 * between that read and the grant insert.
 */
export class GatedAuthorization extends AuthorizationService {
  constructor(
    prisma: PrismaService,
    private readonly gate: Gate,
  ) {
    super(prisma);
  }
  override async assertCanDelegate(
    ...args: Parameters<AuthorizationService['assertCanDelegate']>
  ) {
    await this.gate.pass(args[3] as never);
    return super.assertCanDelegate(...args);
  }
}

/** After the write: the grant is inserted (not committed); its audit entry comes next. */
export class GatedAudit extends AuditService {
  constructor(
    prisma: PrismaService,
    private readonly gate: Gate,
  ) {
    super(prisma);
  }
  override async write(
    input: Parameters<AuditService['write']>[0],
    client?: Parameters<AuditService['write']>[1],
  ) {
    if (input.action === 'ROLE_ASSIGNMENT_CREATED')
      await this.gate.pass(client as never);
    return super.write(input, client);
  }
}
