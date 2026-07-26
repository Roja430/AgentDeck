import { describe, expect, it } from 'vitest';
import { buildEntriesWithProjects } from '../launch-targets.js';

const projects = [
  { path: 'C:\\Users\\me\\Claude Code', name: 'Claude Code' },
  { path: '/work/api', name: 'api' },
];

describe('buildEntriesWithProjects', () => {
  it('leaves the existing agent entries first and unchanged', () => {
    // Anyone with muscle memory for the roll order keeps it.
    const withNone = buildEntriesWithProjects({});
    const withProjects = buildEntriesWithProjects({}, projects);
    expect(withProjects.slice(0, withNone.length)).toEqual(withNone);
  });

  it('appends one new-task entry per project', () => {
    const list = buildEntriesWithProjects({}, projects);
    const news = list.filter((e) => e.newSession);
    expect(news.map((e) => e.label)).toEqual(['New · Claude Code', 'New · api']);
    expect(news[0].newSession).toEqual({ agent: 'claude', cwd: 'C:\\Users\\me\\Claude Code' });
  });

  it('adds nothing when there is no history', () => {
    // An entry that cannot launch anything is worse than a shorter list.
    expect(buildEntriesWithProjects({}, [])).toEqual(buildEntriesWithProjects({}));
  });

  it('leaves target empty on new-task entries so runTarget is never used', () => {
    const entry = buildEntriesWithProjects({}, projects).find((e) => e.newSession)!;
    expect(entry.target).toBe('');
  });

  it('still honours per-agent target overrides', () => {
    const list = buildEntriesWithProjects({ claudeTarget: 'url:https://example.test' }, projects);
    expect(list.find((e) => e.agent === 'claude' && !e.newSession)?.target)
      .toBe('url:https://example.test');
  });
});
