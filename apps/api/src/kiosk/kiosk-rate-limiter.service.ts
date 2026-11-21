import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service.js';
import { sha256 } from './kiosk-secrets.js';

/**
 * Reserves one attempt on every key: increments each counter (setting its window on first use)
 * and refuses, without refunding, when any counter is over its limit. KEYS are the counters;
 * ARGV holds (window ms, limit) per key.
 */
const RESERVE_SCRIPT = `
local allowed = 1
for i, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('PEXPIRE', key, ARGV[(i - 1) * 2 + 1]) end
  if count > tonumber(ARGV[(i - 1) * 2 + 2]) then allowed = 0 end
end
return allowed
`;

/** Gives a reserved attempt back (a successful identification): never below zero. */
const REFUND_SCRIPT = `
for _, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count > 0 then redis.call('DECR', key) end
end
return 1
`;

/**
 * Batch 4B (decision D6): kiosk identification limits count FAILED identifications only, so a
 * busy site's successful clock-ins never use up a shared quota. Every attempt reserves one unit
 * on each counter before the PIN is checked (so concurrent guesses cannot overrun a limit) and a
 * successful identification gives it back. Defaults below; each is configurable.
 */
export const KIOSK_IDENTIFY_DEFAULTS = {
  /** Failures per device (any employee number): a guessing kiosk. */
  deviceLimit: 30,
  deviceWindowMs: 5 * 60_000,
  /** Failures per device and employee number (the PIN itself also locks after 5). */
  deviceEmployeeLimit: 5,
  deviceEmployeeWindowMs: 15 * 60_000,
  /** Failures per employee number across every kiosk: guessing one person from many devices. */
  employeeLimit: 15,
  employeeWindowMs: 15 * 60_000,
  /** Failures per organization across its kiosks: a distributed attack on one organization. */
  organizationLimit: 300,
  organizationWindowMs: 5 * 60_000,
} as const;

/** Enrollment attempts per client address (every attempt counts; enrollment is rare). */
export const KIOSK_ENROLL_LIMIT = 10;
export const KIOSK_ENROLL_WINDOW_MS = 15 * 60_000;

const CONFIG_KEYS: Record<keyof typeof KIOSK_IDENTIFY_DEFAULTS, string> = {
  deviceLimit: 'KIOSK_DEVICE_FAILURE_LIMIT',
  deviceWindowMs: 'KIOSK_DEVICE_FAILURE_WINDOW_SECONDS',
  deviceEmployeeLimit: 'KIOSK_DEVICE_EMPLOYEE_FAILURE_LIMIT',
  deviceEmployeeWindowMs: 'KIOSK_DEVICE_EMPLOYEE_FAILURE_WINDOW_SECONDS',
  employeeLimit: 'KIOSK_EMPLOYEE_FAILURE_LIMIT',
  employeeWindowMs: 'KIOSK_EMPLOYEE_FAILURE_WINDOW_SECONDS',
  organizationLimit: 'KIOSK_ORGANIZATION_FAILURE_LIMIT',
  organizationWindowMs: 'KIOSK_ORGANIZATION_FAILURE_WINDOW_SECONDS',
};

export type KioskIdentifyLimits = {
  -readonly [K in keyof typeof KIOSK_IDENTIFY_DEFAULTS]: number;
};

/** One reserved identification attempt: give it back on success with `refund`. */
export interface KioskIdentifyReservation {
  keys: string[];
}

/**
 * Brute-force protection for the kiosk (Redis, like the login limiter). Fails closed: without
 * Redis, kiosk identification and enrollment are unavailable rather than unlimited.
 */
@Injectable()
export class KioskRateLimiterService {
  readonly limits: KioskIdentifyLimits;

  constructor(
    private readonly redis: RedisService,
    @Optional() config?: ConfigService,
  ) {
    this.limits = { ...KIOSK_IDENTIFY_DEFAULTS };
    for (const [name, key] of Object.entries(CONFIG_KEYS) as Array<
      [keyof KioskIdentifyLimits, string]
    >) {
      const configured = Number(config?.get<string | number>(key));
      if (Number.isInteger(configured) && configured > 0) {
        this.limits[name] = name.endsWith('WindowMs')
          ? configured * 1000
          : configured;
      }
    }
  }

  /**
   * Reserves one identification attempt on the device, device-and-number, number and
   * organization failure counters; 429 when any of them is already at its limit.
   */
  async reserveIdentify(device: {
    id: string;
    organizationId: string;
    employeeNumber: string;
  }): Promise<KioskIdentifyReservation> {
    const number = sha256(device.employeeNumber);
    const limits: Array<[string, number, number]> = [
      [
        `kiosk:fail:device:${device.id}`,
        this.limits.deviceWindowMs,
        this.limits.deviceLimit,
      ],
      [
        `kiosk:fail:device-employee:${device.id}:${number}`,
        this.limits.deviceEmployeeWindowMs,
        this.limits.deviceEmployeeLimit,
      ],
      [
        `kiosk:fail:employee:${number}`,
        this.limits.employeeWindowMs,
        this.limits.employeeLimit,
      ],
      [
        `kiosk:fail:organization:${device.organizationId}`,
        this.limits.organizationWindowMs,
        this.limits.organizationLimit,
      ],
    ];
    await this.check(limits);
    return { keys: limits.map(([key]) => key) };
  }

  /** A successful identification: the reserved attempt was not a failure. */
  async refund(reservation: KioskIdentifyReservation) {
    try {
      await this.redis.client.eval(
        REFUND_SCRIPT,
        reservation.keys.length,
        ...reservation.keys,
      );
    } catch {
      // Not refunding only makes the limit stricter; the identification itself succeeded.
    }
  }

  assertEnrollAllowed(ip: string) {
    return this.check([
      [
        `kiosk:rate:enroll:${sha256(ip)}`,
        KIOSK_ENROLL_WINDOW_MS,
        KIOSK_ENROLL_LIMIT,
      ],
    ]);
  }

  private async check(limits: Array<[string, number, number]>) {
    try {
      const allowed = await this.redis.client.eval(
        RESERVE_SCRIPT,
        limits.length,
        ...limits.map(([key]) => key),
        ...limits.flatMap(([, window, limit]) => [window, limit]),
      );
      if (allowed !== 1) {
        throw new HttpException(
          {
            statusCode: 429,
            error: 'Too Many Requests',
            code: 'KIOSK_RATE_LIMITED',
            message: 'Too many attempts. Please wait and try again.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (error) {
      if (
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.TOO_MANY_REQUESTS
      ) {
        throw error;
      }
      throw new ServiceUnavailableException(
        'The kiosk is temporarily unavailable.',
      );
    }
  }
}
