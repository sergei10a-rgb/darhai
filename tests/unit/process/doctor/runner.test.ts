import { describe, it, expect } from 'vitest';
import { runDoctor } from '@process/doctor/runner';
import type { DoctorCheck, DoctorCheckOutcome } from '@process/doctor/types';
import { settleTurns } from '../../../helpers/eventLoop';

function makeCheck(id: string, run: () => Promise<DoctorCheckOutcome>): DoctorCheck {
  return { id, titleKey: `settings.doctor.checks.${id}.title`, category: 'system', run };
}

describe('runDoctor', () => {
  it('aggregates the worst status and per-status counts', async () => {
    const report = await runDoctor([
      makeCheck('a', async () => ({ status: 'pass', detail: 'ok' })),
      makeCheck('b', async () => ({ status: 'warn', detail: 'meh' })),
      makeCheck('c', async () => ({ status: 'fail', detail: 'bad', remediation: 'fix it' })),
    ]);

    expect(report.overall).toBe('fail');
    expect(report.counts).toEqual({ pass: 1, warn: 1, fail: 1 });
    expect(report.results).toHaveLength(3);
    expect(Date.parse(report.ranAt)).not.toBeNaN();
  });

  it('reports pass overall when every check passes', async () => {
    const report = await runDoctor([
      makeCheck('a', async () => ({ status: 'pass', detail: 'ok' })),
      makeCheck('b', async () => ({ status: 'pass', detail: 'ok' })),
    ]);
    expect(report.overall).toBe('pass');
    expect(report.counts).toEqual({ pass: 2, warn: 0, fail: 0 });
  });

  it('turns a thrown check into a fail without aborting the battery', async () => {
    const report = await runDoctor([
      makeCheck('boom', async () => {
        throw new Error('kaput');
      }),
      makeCheck('fine', async () => ({ status: 'pass', detail: 'ok' })),
    ]);

    expect(report.results[0].status).toBe('fail');
    expect(report.results[0].detail).toContain('kaput');
    expect(report.results[1].status).toBe('pass');
    expect(report.overall).toBe('fail');
  });

  it('bounds a hanging check with the per-check timeout', async () => {
    const report = await runDoctor(
      [
        makeCheck('hang', () => new Promise<DoctorCheckOutcome>(() => {})),
        makeCheck('fine', async () => ({ status: 'pass', detail: 'ok' })),
      ],
      50
    );

    expect(report.results[0].status).toBe('fail');
    expect(report.results[0].detail).toContain('timed out');
    expect(report.results[1].status).toBe('pass');
  });

  it('keeps result order stable regardless of completion order', async () => {
    const report = await runDoctor([
      makeCheck('slow', async () => {
        // Event-loop turns, not wall clock: a loaded 24-fork run can stall a
        // real timer while microtasks still drain deterministically.
        await settleTurns(25);
        return { status: 'pass', detail: 's' };
      }),
      makeCheck('fast', async () => ({ status: 'pass', detail: 'f' })),
    ]);

    expect(report.results.map((result) => result.id)).toEqual(['slow', 'fast']);
  });
});
