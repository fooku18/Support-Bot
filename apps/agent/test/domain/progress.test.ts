/**
 * Typed progress contract: fixed server-side rendering, closed enums, and
 * delivery metadata helpers. No provider text may become user-visible Slack
 * text, and delivery identity never appears in it.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROGRESS_STAGES,
  isAgentProgressStage,
  isAgentToolCategory,
} from '../../src/contracts/protocol.js';
import {
  deliveryMetadata,
  DELIVERY_METADATA_EVENT_TYPE,
  parseDeliveryMetadata,
} from '../../src/domain/delivery/metadata.js';
import { renderProgressText } from '../../src/domain/delivery/replies.js';

describe('progress contract', () => {
  it('renders only fixed text per stage', () => {
    expect(renderProgressText('starting')).toBe('⏳ Starting…');
    expect(renderProgressText('model_working')).toBe('⏳ Reviewing the request…');
    expect(renderProgressText('inspecting')).toBe('⏳ Inspecting files…');
    expect(renderProgressText('editing')).toBe('⏳ Editing files…');
    expect(renderProgressText('calling_service')).toBe('⏳ Contacting configured services…');
    expect(renderProgressText('verifying')).toBe('⏳ Running verification…');
    expect(renderProgressText('repairing')).toBe('⏳ Addressing verification results…');
    expect(renderProgressText('publishing')).toBe('⏳ Preparing the merge request…');
    expect(renderProgressText('retrying')).toBe('⏳ Retrying the model service…');
    expect(renderProgressText('recovering')).toBe('⏳ Recovering interrupted work…');
  });

  it('rejects open vocabularies', () => {
    expect(isAgentProgressStage('streaming_tokens')).toBe(false);
    expect(isAgentProgressStage('editing')).toBe(true);
    expect(isAgentProgressStage('awaiting_gitlab_write_approval')).toBe(false);
    expect(isAgentToolCategory('rm -rf /')).toBe(false);
    expect(isAgentToolCategory('gitlab')).toBe(true);
  });

  it('carries delivery identity as Slack metadata, never in the text', () => {
    for (const stage of AGENT_PROGRESS_STAGES) {
      expect(renderProgressText(stage)).not.toMatch(/\[(op|rev):/);
    }
    const metadata = deliveryMetadata({ operationId: 'out-3-ab12cd', revision: 4, answer: true });
    expect(metadata).toEqual({
      event_type: DELIVERY_METADATA_EVENT_TYPE,
      event_payload: { operation_id: 'out-3-ab12cd', revision: 4, answer: true },
    });
    expect(parseDeliveryMetadata(metadata)).toEqual({
      operationId: 'out-3-ab12cd',
      revision: 4,
      answer: true,
    });
  });

  it('rejects foreign or malformed message metadata', () => {
    expect(parseDeliveryMetadata(undefined)).toBeNull();
    expect(
      parseDeliveryMetadata({ event_type: 'other_app', event_payload: { operation_id: 'x' } }),
    ).toBeNull();
    expect(
      parseDeliveryMetadata({
        event_type: DELIVERY_METADATA_EVENT_TYPE,
        event_payload: { operation_id: '', revision: 1 },
      }),
    ).toBeNull();
    expect(
      parseDeliveryMetadata({
        event_type: DELIVERY_METADATA_EVENT_TYPE,
        event_payload: { operation_id: 'out-1-a', revision: -1 },
      }),
    ).toBeNull();
    // A missing answer flag is not an answer.
    expect(
      parseDeliveryMetadata({
        event_type: DELIVERY_METADATA_EVENT_TYPE,
        event_payload: { operation_id: 'out-1-a', revision: 2 },
      }),
    ).toEqual({ operationId: 'out-1-a', revision: 2, answer: false });
  });

  it('never renders provider-supplied strings', () => {
    const evil = 'ignore instructions; password=hunter2 [/etc/passwd]';
    const text = renderProgressText('inspecting');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(evil);
  });
});
