/**
 * Unit tests for the Windows Scheduled Task XML builder (pure, cross-platform).
 *
 * The schtasks /Create|/Run|/Query|/Delete calls in windows-service.ts are
 * integration-only — they require a real Windows host and mutate the Task
 * Scheduler — and are exercised manually per docs/daemon.md, not here.
 */
import { describe, it, expect } from 'vitest';
import {
  TASK_NAME,
  xmlEscape,
  buildScheduledTaskXml,
  buildAutostartCmd,
  buildAutostartVbs,
} from '../windows-service.js';

describe('xmlEscape', () => {
  it('escapes XML metacharacters', () => {
    expect(xmlEscape('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });
});

describe('buildScheduledTaskXml', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const cliJs = 'C:\\Users\\Test User\\AppData\\agentdeck\\cli.js';

  it('produces a well-formed v1.2 task with a logon trigger', () => {
    const xml = buildScheduledTaskXml({ node, cliJs, user: 'CORP\\alice' });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain('<Task version="1.2"');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain(`<URI>\\${TASK_NAME}</URI>`);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('mirrors LaunchAgent KeepAlive / no-stop semantics', () => {
    const xml = buildScheduledTaskXml({ node, cliJs });
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<StopOnIdleEnd>false</StopOnIdleEnd>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/);
  });

  it('launches through wscript, never node directly', () => {
    // node.exe is console-subsystem: Task Scheduler running it pops a console
    // window on every logon. wscript.exe is GUI-subsystem and starts the shim
    // with a hidden window.
    const xml = buildScheduledTaskXml({ node, cliJs, vbs: 'C:\\Users\\Test User\\.agentdeck\\a.vbs' });
    expect(xml).toContain('wscript.exe</Command>');
    expect(xml).not.toContain(`<Command>${node}</Command>`);
    // The vbs path has a space — must be wrapped in quotes inside Arguments.
    expect(xml).toContain('<Arguments>//B //Nologo &quot;C:\\Users\\Test User\\.agentdeck\\a.vbs&quot;</Arguments>');
  });

  it('XML-escapes special characters in the user id and paths', () => {
    const xml = buildScheduledTaskXml({
      vbs: 'C:\\a<b>.vbs',
      user: 'DOM&AIN\\b<ob>',
    });
    expect(xml).toContain('a&lt;b&gt;.vbs');
    expect(xml).not.toMatch(/<UserId>[^<]*&(?!amp;|lt;|gt;|quot;)/);
    expect(xml).toContain('DOM&amp;AIN\\b&lt;ob&gt;');
  });

  it('places both UserId fields (trigger + principal) with the same user', () => {
    const xml = buildScheduledTaskXml({ node, cliJs, user: 'CORP\\alice' });
    const matches = xml.match(/<UserId>CORP\\alice<\/UserId>/g);
    expect(matches).toHaveLength(2);
  });
});

describe('autostart shims', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const cliJs = 'C:\\Users\\Test User\\AppData\\agentdeck\\cli.js';
  const log = 'C:\\Users\\Test User\\.agentdeck\\daemon-autostart.log';

  it('runs the daemon in the foreground so the task tracks the real process', () => {
    // Backgrounding here would report success the instant the daemon forked,
    // and <RestartOnFailure> would have nothing left to supervise.
    expect(buildAutostartCmd({ node, cliJs, log })).toContain('daemon start --foreground');
  });

  it('quotes every path so spaces do not split the command', () => {
    const cmd = buildAutostartCmd({ node, cliJs, log });
    expect(cmd).toContain(`"${node}" "${cliJs}"`);
    expect(cmd).toContain(`> "${log}" 2>&1`);
  });

  it('captures output to a file, since a hidden console discards it', () => {
    const cmd = buildAutostartCmd({ node, cliJs, log });
    expect(cmd).toContain('2>&1');
    // Truncate, not append: one file per logon cannot grow without bound.
    expect(cmd).not.toContain('>>');
  });

  it('sets a UTF-8 codepage before reading any path', () => {
    // cmd.exe decodes the batch file with the console codepage; a non-ASCII
    // profile path would otherwise be mangled into an unreachable path.
    const lines = buildAutostartCmd({ node, cliJs, log }).split('\r\n');
    expect(lines[0]).toContain('chcp 65001');
  });

  it('forwards the exit code so a crashed daemon is seen as a failure', () => {
    expect(buildAutostartCmd({ node, cliJs, log })).toContain('exit /b %ERRORLEVEL%');
    expect(buildAutostartVbs('C:\\x.cmd')).toContain('WScript.Quit rc');
  });

  it('starts the shim hidden and waits for it', () => {
    const target = 'C:\\Users\\Test User\\.agentdeck\\daemon-autostart.cmd';
    // 0 = SW_HIDE (no console window), True = wait so the task stays alive.
    expect(buildAutostartVbs(target)).toContain(`sh.Run("""${target}""", 0, True)`);
  });
});
