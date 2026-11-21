import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  it('writes generic audit events', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'audit-id' });
    const module = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: PrismaService,
          useValue: { auditLog: { create } },
        },
      ],
    }).compile();
    const service = module.get(AuditService);
    const input = {
      action: 'user.created',
      entityType: 'User',
      entityId: 'user-id',
      correlationId: 'request-id',
      metadata: { source: 'admin' },
    };

    await service.write(input);

    expect(create).toHaveBeenCalledWith({ data: input });
    await module.close();
  });
});
