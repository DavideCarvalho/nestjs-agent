import {
  AGENT_ATTACHMENT_STAGING,
  AGENT_STORE,
  type AgentStore,
} from '@dudousxd/nestjs-agent-core';
import {
  MEDIA_STORAGE_SHARED,
  MEDIA_STORE,
  MEDIA_UPLOADS,
  type MediaStore,
  type ResumableUploadManager,
  type StorageManager,
} from '@dudousxd/nestjs-media';
import {
  type CanActivate,
  type DynamicModule,
  Global,
  Module,
  type Provider,
  type Type,
} from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { MediaAttachmentStaging } from './media-attachment-staging.js';
import type {
  AgentMediaAttachmentsAsyncOptions,
  AgentMediaAttachmentsModuleOptions,
  AgentMediaAttachmentsMountOptions,
  AgentMediaAttachmentsOptions,
} from './media-attachments.options.js';
import { AgentMediaUploadsController } from './media-uploads.controller.js';
import { AGENT_MEDIA_ATTACHMENTS, AGENT_MEDIA_ATTACHMENTS_OPTIONS } from './tokens.js';

/** See `agent.module.ts` — Nest's `GUARDS_METADATA` key, inlined for the same ESM reason. */
const GUARDS_METADATA = '__guards__';

function stagingProvider(): Provider {
  return {
    provide: AGENT_MEDIA_ATTACHMENTS,
    inject: [
      AGENT_MEDIA_ATTACHMENTS_OPTIONS,
      MEDIA_STORAGE_SHARED,
      MEDIA_STORE,
      MEDIA_UPLOADS,
      { token: AGENT_STORE, optional: true },
    ],
    useFactory: (
      options: AgentMediaAttachmentsOptions,
      storage: StorageManager,
      store: MediaStore | null,
      uploads: ResumableUploadManager | null,
      agentStore: AgentStore | undefined,
    ) => {
      if (store === null) {
        throw new Error(
          'AgentMediaAttachmentsModule: MediaModule has no `store`. Chat attachments are media ' +
            'records, so configure MediaModule with a MediaStore (e.g. a database adapter).',
        );
      }
      return new MediaAttachmentStaging(
        { storage, store, uploads, ...(agentStore !== undefined ? { agentStore } : {}) },
        options,
      );
    },
  };
}

function build(
  mount: AgentMediaAttachmentsMountOptions,
  optionsProvider: Provider,
  imports: DynamicModule['imports'] = [],
): DynamicModule {
  const routes = mount.routes !== false;
  Reflect.defineMetadata(GUARDS_METADATA, mount.guards ?? [], AgentMediaUploadsController);
  const guards: Type<CanActivate>[] = [...new Set(mount.guards ?? [])];
  return {
    module: AgentMediaAttachmentsModule,
    global: true,
    imports: [
      ...imports,
      ...(routes
        ? [
            RouterModule.register([
              { path: mount.path ?? 'agent', module: AgentMediaAttachmentsModule },
            ]),
          ]
        : []),
    ],
    controllers: routes ? [AgentMediaUploadsController] : [],
    providers: [
      optionsProvider,
      stagingProvider(),
      { provide: AGENT_ATTACHMENT_STAGING, useExisting: AGENT_MEDIA_ATTACHMENTS },
      { provide: MediaAttachmentStaging, useExisting: AGENT_MEDIA_ATTACHMENTS },
      ...guards,
    ],
    exports: [AGENT_ATTACHMENT_STAGING, AGENT_MEDIA_ATTACHMENTS, MediaAttachmentStaging],
  };
}

/**
 * Chat attachments on `@dudousxd/nestjs-media`: binds `AGENT_ATTACHMENT_STAGING` to a
 * media-backed store and mounts the resumable-upload routes (`<path>/attachments/uploads`).
 * Import it next to `AgentModule` and a `MediaModule` configured with `store`, `uploadSessions`
 * and `tus`.
 */
@Global()
@Module({})
export class AgentMediaAttachmentsModule {
  static forRoot(options: AgentMediaAttachmentsModuleOptions = {}): DynamicModule {
    return build(options, { provide: AGENT_MEDIA_ATTACHMENTS_OPTIONS, useValue: options });
  }

  static forRootAsync(options: AgentMediaAttachmentsAsyncOptions): DynamicModule {
    return build(
      options,
      {
        provide: AGENT_MEDIA_ATTACHMENTS_OPTIONS,
        inject: options.inject ?? [],
        useFactory: options.useFactory,
      },
      options.imports,
    );
  }
}
