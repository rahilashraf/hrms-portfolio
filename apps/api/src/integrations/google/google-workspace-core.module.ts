import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service.js';
import {
  FetchGoogleApiClient,
  GOOGLE_API_CLIENT,
  type GoogleApiClient,
} from './google-api.client.js';
import { CredentialCipher } from './google-credential-cipher.js';
import { GoogleFormsReader } from './google-forms.adapters.js';
import {
  DefaultGoogleTokenProvider,
  GOOGLE_TOKEN_PROVIDER,
  type GoogleTokenProvider,
} from './google-token.provider.js';
import {
  GOOGLE_WORKSPACE_SETTINGS,
  GoogleWorkspaceClock,
  googleWorkspaceSettingsFromEnv,
  type GoogleWorkspaceSettings,
} from './google-workspace-common.js';
import { GoogleWorkspaceRuntime } from './google-workspace-runtime.js';
import {
  GoogleDriveStorageAdapter,
  GoogleSheetsExportService,
} from './google-workspace.adapters.js';

const ENV_KEYS = [
  'NODE_ENV',
  'WEB_ORIGIN',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'INTEGRATION_ENCRYPTION_KEY',
  'INTEGRATION_ENCRYPTION_PREVIOUS_KEYS',
] as const;

function environment(config: ConfigService) {
  return Object.fromEntries(
    ENV_KEYS.map((key) => {
      const value = config.get<unknown>(key);
      return [
        key,
        typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : undefined,
      ];
    }),
  ) as Record<string, string | undefined>;
}

/**
 * Phase 16.5 — the shared Google Workspace platform, free of domain dependencies so domain
 * modules (Documents, Notifications) can register its adapters: settings, credential cipher,
 * API client, token provider, the per-organization runtime and the Drive / Forms / Sheets
 * adapters. No Google API is called at startup.
 */
@Module({
  providers: [
    GoogleWorkspaceClock,
    {
      provide: GOOGLE_WORKSPACE_SETTINGS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        googleWorkspaceSettingsFromEnv(environment(config)),
    },
    {
      provide: CredentialCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        CredentialCipher.fromEnvironment(environment(config)),
    },
    {
      provide: GOOGLE_API_CLIENT,
      useFactory: () => new FetchGoogleApiClient(),
    },
    {
      provide: GOOGLE_TOKEN_PROVIDER,
      inject: [
        GOOGLE_API_CLIENT,
        CredentialCipher,
        GOOGLE_WORKSPACE_SETTINGS,
        GoogleWorkspaceClock,
      ],
      useFactory: (
        api: GoogleApiClient,
        cipher: CredentialCipher,
        settings: GoogleWorkspaceSettings,
        clock: GoogleWorkspaceClock,
      ) => new DefaultGoogleTokenProvider(api, cipher, settings, clock),
    },
    {
      provide: GoogleWorkspaceRuntime,
      inject: [
        PrismaService,
        CredentialCipher,
        GOOGLE_TOKEN_PROVIDER,
        GoogleWorkspaceClock,
      ],
      useFactory: (
        prisma: PrismaService,
        cipher: CredentialCipher,
        tokens: GoogleTokenProvider,
        clock: GoogleWorkspaceClock,
      ) => new GoogleWorkspaceRuntime(prisma, cipher, tokens, clock),
    },
    {
      provide: GoogleFormsReader,
      inject: [GoogleWorkspaceRuntime, GOOGLE_API_CLIENT],
      useFactory: (runtime: GoogleWorkspaceRuntime, api: GoogleApiClient) =>
        new GoogleFormsReader(runtime, api),
    },
    {
      provide: GoogleDriveStorageAdapter,
      inject: [GoogleWorkspaceRuntime, GOOGLE_API_CLIENT],
      useFactory: (runtime: GoogleWorkspaceRuntime, api: GoogleApiClient) =>
        new GoogleDriveStorageAdapter(runtime, api),
    },
    {
      provide: GoogleSheetsExportService,
      inject: [GoogleWorkspaceRuntime, GOOGLE_API_CLIENT],
      useFactory: (runtime: GoogleWorkspaceRuntime, api: GoogleApiClient) =>
        new GoogleSheetsExportService(runtime, api),
    },
  ],
  exports: [
    GoogleWorkspaceClock,
    GOOGLE_WORKSPACE_SETTINGS,
    CredentialCipher,
    GOOGLE_API_CLIENT,
    GOOGLE_TOKEN_PROVIDER,
    GoogleWorkspaceRuntime,
    GoogleFormsReader,
    GoogleDriveStorageAdapter,
    GoogleSheetsExportService,
  ],
})
export class GoogleWorkspaceCoreModule {}
