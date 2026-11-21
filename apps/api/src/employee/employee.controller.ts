import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import {
  AssignmentImpactQueryDto,
  AttachLookupQueryDto,
  TransferAssignmentDto,
  CancelTerminationDto,
  RecordGrantDecisionsDto,
  ReviewGrantKeepDto,
  CreateAssignmentDto,
  InactivateEmployeeDto,
  LifecycleDueQueryDto,
  ReactivateEmployeeDto,
  RevokeEmployeeGrantsDto,
  TerminationPreviewQueryDto,
  CreateEmployeeDto,
  CorrectAssignmentDto,
  EmployeeDirectoryQueryDto,
  EmployeeOptionQueryDto,
  EndAssignmentDto,
  ManagerAssignmentDto,
  ManagerAssignmentOptionQueryDto,
  PositionOptionQueryDto,
  PrimaryAssignmentDto,
  RehireEmployeeDto,
  TerminateEmployeeDto,
  UpdateEmployeeDto,
} from './employee.dto.js';
import { EmployeeAssignmentOperationsService } from './employee-assignment-operations.service.js';
import { EmployeeLifecycleService } from './employee-lifecycle.service.js';
import { EmployeeService } from './employee.service.js';

@Controller('employees')
@UseGuards(AccessTokenGuard)
export class EmployeeController {
  constructor(
    private readonly employees: EmployeeService,
    private readonly lifecycle: EmployeeLifecycleService,
    private readonly operations: EmployeeAssignmentOperationsService,
  ) {}
  private context(identity: AuthenticatedIdentity, request: Request) {
    return {
      actorUserId: identity.userId,
      ipAddress: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      correlationId: request.get('x-correlation-id') ?? undefined,
    };
  }
  @Post() create(
    @Body() body: CreateEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.create(body, this.context(identity, request));
  }
  @Get() directory(
    @Query() query: EmployeeDirectoryQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.employees.directory(query, identity.userId);
  }
  @Get('options/people') peopleOptions(
    @Query() query: EmployeeOptionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.employees.peopleOptions(query, identity.userId);
  }
  @Get('options/positions') positionOptions(
    @Query() query: PositionOptionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.employees.positionOptions(query, identity.userId);
  }
  @Get('options/manager-assignments') managerAssignmentOptions(
    @Query() query: ManagerAssignmentOptionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.employees.managerAssignmentOptions(query, identity.userId);
  }
  /** Batch 5A (R1): due terminations and assignment ends the caller manages (before ':id'). */
  @Get('lifecycle/due') lifecycleDue(
    @Query() query: LifecycleDueQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.lifecycle.due(
      identity.userId,
      query.organizationId,
      undefined,
      {
        upcomingDays: query.upcomingDays,
      },
    );
  }
  /** Batch 5A (K5): exact employee-number lookup for organization-wide attach (audited). */
  @Get('attach-lookup') attachLookup(
    @Query() query: AttachLookupQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.attachLookup(
      query.organizationId,
      query.employeeNumber,
      this.context(identity, request),
    );
  }
  /** My Profile: the caller's own record (declared before ':id'). */
  @Get('me') me(@AuthUser() identity: AuthenticatedIdentity) {
    return this.employees.me(identity.userId);
  }
  @Get(':id') profile(
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.employees.profile(id, identity.userId);
  }
  @Patch(':id') update(
    @Param('id') id: string,
    @Body() body: UpdateEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.update(id, body, this.context(identity, request));
  }
  @Post(':id/assignments') assignment(
    @Param('id') id: string,
    @Body() body: CreateAssignmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.createAssignment(
      id,
      body,
      this.context(identity, request),
    );
  }
  @Patch(':id/assignments/:assignmentId') correct(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: CorrectAssignmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.correctAssignment(
      id,
      assignmentId,
      body,
      this.context(identity, request),
    );
  }
  @Post(':id/assignments/:assignmentId/end') end(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: EndAssignmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.endAssignment(
      id,
      assignmentId,
      body,
      this.context(identity, request),
    );
  }
  @Post(':id/assignments/:assignmentId/cancel') cancel(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.cancelAssignment(
      id,
      assignmentId,
      this.context(identity, request),
    );
  }
  @Post(':id/assignments/:assignmentId/activate') activate(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.activateAssignment(
      id,
      assignmentId,
      this.context(identity, request),
    );
  }
  @Patch(':id/assignments/:assignmentId/primary') primary(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: PrimaryAssignmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.setPrimary(
      id,
      assignmentId,
      body.isPrimary,
      this.context(identity, request),
    );
  }
  @Patch(':id/assignments/:assignmentId/manager') manager(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: ManagerAssignmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.employees.setManager(
      id,
      assignmentId,
      body.managerAssignmentId,
      this.context(identity, request),
    );
  }
  @Post(':id/terminate') terminate(
    @Param('id') id: string,
    @Body() body: TerminateEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.terminate(id, body, this.context(identity, request));
  }
  @Get(':id/terminations') terminations(
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.lifecycle.terminations(id, identity.userId);
  }
  @Get(':id/termination-preview') terminationPreview(
    @Param('id') id: string,
    @Query() query: TerminationPreviewQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.lifecycle.terminationPreview(
      id,
      query.terminationDate,
      identity.userId,
    );
  }
  @Post(':id/terminations/:terminationId/cancel') cancelTermination(
    @Param('id') id: string,
    @Param('terminationId') terminationId: string,
    @Body() body: CancelTerminationDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.cancelTermination(
      id,
      terminationId,
      body,
      this.context(identity, request),
    );
  }
  @Post(':id/terminations/:terminationId/reschedule') rescheduleTermination(
    @Param('id') id: string,
    @Param('terminationId') terminationId: string,
    @Body() body: TerminateEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.rescheduleTermination(
      id,
      terminationId,
      body,
      this.context(identity, request),
    );
  }
  @Post(':id/terminations/:terminationId/apply') applyTermination(
    @Param('id') id: string,
    @Param('terminationId') terminationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.applyTermination(
      id,
      terminationId,
      this.context(identity, request),
    );
  }
  // ─── M3: role grants at termination ──────────────────────────────────────
  @Get(':id/terminations/:terminationId/grants') terminationGrants(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('terminationId', ParseUUIDPipe) terminationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.lifecycle.terminationGrants(id, terminationId, identity.userId);
  }
  @Post(':id/terminations/:terminationId/grant-decisions')
  @HttpCode(200)
  recordGrantDecisions(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('terminationId', ParseUUIDPipe) terminationId: string,
    @Body() body: RecordGrantDecisionsDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.recordGrantDecisions(
      id,
      terminationId,
      { decisions: body.decisions },
      this.context(identity, request),
    );
  }
  @Post(':id/terminations/:terminationId/grant-decisions/:decisionId/approve')
  @HttpCode(200)
  approveGrantKeep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('terminationId', ParseUUIDPipe) terminationId: string,
    @Param('decisionId', ParseUUIDPipe) decisionId: string,
    @Body() body: ReviewGrantKeepDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.approveGrantKeep(
      id,
      terminationId,
      decisionId,
      body.note !== undefined ? { note: body.note } : {},
      this.context(identity, request),
    );
  }
  @Post(':id/terminations/:terminationId/grant-decisions/:decisionId/reject')
  @HttpCode(200)
  rejectGrantKeep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('terminationId', ParseUUIDPipe) terminationId: string,
    @Param('decisionId', ParseUUIDPipe) decisionId: string,
    @Body() body: ReviewGrantKeepDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.rejectGrantKeep(
      id,
      terminationId,
      decisionId,
      body.note !== undefined ? { note: body.note } : {},
      this.context(identity, request),
    );
  }
  @Post(':id/terminations/:terminationId/grant-decisions/:decisionId/cancel')
  @HttpCode(200)
  cancelGrantKeep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('terminationId', ParseUUIDPipe) terminationId: string,
    @Param('decisionId', ParseUUIDPipe) decisionId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.cancelGrantKeep(
      id,
      terminationId,
      decisionId,
      this.context(identity, request),
    );
  }
  @Post(':id/assignments/:assignmentId/apply-end') applyAssignmentEnd(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.applyAssignmentEnd(
      id,
      assignmentId,
      this.context(identity, request),
    );
  }
  @Post(':id/rehire') rehire(
    @Param('id') id: string,
    @Body() body: RehireEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.rehire(id, body, this.context(identity, request));
  }
  @Post(':id/inactivate') inactivate(
    @Param('id') id: string,
    @Body() body: InactivateEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.inactivate(id, body, this.context(identity, request));
  }
  @Post(':id/reactivate') reactivate(
    @Param('id') id: string,
    @Body() body: ReactivateEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.reactivate(id, body, this.context(identity, request));
  }
  @Get(':id/access-review') accessReview(
    @Param('id') id: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.lifecycle.accessReview(id, identity.userId);
  }
  @Post(':id/access-review/revoke-grants') revokeGrants(
    @Param('id') id: string,
    @Body() body: RevokeEmployeeGrantsDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.revokeGrants(
      id,
      body,
      this.context(identity, request),
    );
  }
  /** Batch 5B (K6): atomic transfer to another position. */
  @Post(':id/assignments/:assignmentId/transfer') transfer(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: TransferAssignmentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.operations.transfer(
      id,
      assignmentId,
      body,
      this.context(identity, request),
    );
  }
  /** Batch 5B (K8): what ending this assignment would leave behind (read-only). */
  @Get(':id/assignments/:assignmentId/impact') impact(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Query() query: AssignmentImpactQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.operations.impact(id, assignmentId, identity.userId, query);
  }
}
