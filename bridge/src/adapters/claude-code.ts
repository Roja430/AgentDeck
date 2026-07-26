import { OutputParser } from '../output-parser.js';
import { debug } from '../logger.js';
import type { AgentCapabilities, PluginCommand } from '../types.js';
import { CLAUDE_CODE_CAPABILITIES } from '../types.js';
import { PtyAdapter } from './pty-adapter.js';

/**
 * Claude Code adapter — extends PtyAdapter with Claude-specific output parsing
 * and mode switching (Shift+Tab).
 */
export class ClaudeCodeAdapter extends PtyAdapter {
  readonly capabilities: AgentCapabilities = CLAUDE_CODE_CAPABILITIES;

  private outputParser: OutputParser;
  /** Mode switch debounce */
  private lastModeSwitchTime = 0;
  /** When the `/model` picker was last opened or nudged; 0 = closed. */
  private effortPickerOpenedAt = 0;
  /** How long an opened picker is assumed to still be on screen. */
  static readonly EFFORT_PICKER_TTL_MS = 15_000;
  /** Gap between opening the picker and the first arrow key. */
  static readonly EFFORT_PICKER_OPEN_DELAY_MS = 250;

  constructor() {
    super();
    this.outputParser = new OutputParser();
  }

  protected getDefaultCommand(): string {
    return 'claude';
  }

  protected wireOutputParser(): void {
    // Parser events → AdapterEvents
    const parserEvents = [
      'spinner_start',
      'spinner_stop',
      'permission_prompt',
      'option_prompt',
      'diff_prompt',
      'idle',
      'status_line',
      'tool_action',
      'project_name',
      'model_info',
      // The parser emitted this and the state machine had a handler for it, but
      // nothing connected the two — so effortLevel was never reported and the
      // deck's effort dial had no value to show.
      'effort_level',
      'mode_change',
      'suggested_prompt',
      'remote_url',
    ];
    for (const eventName of parserEvents) {
      this.outputParser.on(eventName, (data?: Record<string, unknown>) => {
        this.emitAdapterEvent({ source: 'parser', event: eventName, data });
      });
    }

    // cursor_update → metadata
    this.outputParser.on('cursor_update', (data?: Record<string, unknown>) => {
      this.emitAdapterEvent({ source: 'metadata', event: 'cursor_update', data: data ?? {} });
    });

    // usage_info → metadata
    this.outputParser.on('usage_info', (data?: Record<string, unknown>) => {
      if (data) {
        this.emitAdapterEvent({ source: 'metadata', event: 'usage_info', data });
      }
    });

    // user_prompt → metadata
    this.outputParser.on('user_prompt', (data?: Record<string, unknown>) => {
      const text = data?.text as string | undefined;
      if (text) {
        this.emitAdapterEvent({ source: 'metadata', event: 'user_prompt', data: { text } });
      }
    });
  }

  protected feedParser(data: string): void {
    this.outputParser.feed(data);
  }

  protected handleAgentCommand(cmd: PluginCommand): boolean {
    if (cmd.type === 'switch_mode') {
      const now = Date.now();
      if (now - this.lastModeSwitchTime < 100) {
        debug('adapter:claude', `switch_mode: debounced (${now - this.lastModeSwitchTime}ms < 100ms)`);
        return true;
      }
      this.lastModeSwitchTime = now;
      debug('adapter:claude', 'switch_mode: sending Shift+Tab');
      this.outputParser.notifyModeSwitchSent();
      this.ptyManager.write('\x1b[Z');
      return true;
    }
    if (cmd.type === 'set_effort') {
      if (cmd.action === 'set') {
        this.handleSetEffortLevel(cmd.level);
        return true;
      }
      this.handleSetEffort(cmd.action);
      return true;
    }
    if (cmd.type === 'set_model') {
      this.handleSetModel(cmd.model);
      return true;
    }
    return false;
  }

  /**
   * Anything sent here is typed into a live prompt, so it must not be able to
   * carry a newline (which would submit something we did not compose) or shell
   * punctuation. Model keys and effort levels are both plain identifiers.
   */
  private static readonly SAFE_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  /** `/effort <level>` — direct, unlike the picker-nudging path below. */
  private handleSetEffortLevel(level: string | undefined): void {
    if (!level || !ClaudeCodeAdapter.SAFE_ARGUMENT.test(level)) {
      debug('adapter:claude', `set_effort: rejected level ${JSON.stringify(level)}`);
      return;
    }
    // A picker left open from the older nudge path would swallow this line.
    if (this.effortPickerOpenedAt) {
      this.ptyManager.write('\x1b');
      this.effortPickerOpenedAt = 0;
    }
    debug('adapter:claude', `set_effort: /effort ${level}`);
    this.ptyManager.write(`/effort ${level}\r`);
  }

  /** `/model <name>` — session-scoped, applied without opening the picker. */
  private handleSetModel(model: string): void {
    if (!model || !ClaudeCodeAdapter.SAFE_ARGUMENT.test(model)) {
      debug('adapter:claude', `set_model: rejected ${JSON.stringify(model)}`);
      return;
    }
    debug('adapter:claude', `set_model: /model ${model}`);
    this.ptyManager.write(`/model ${model}\r`);
  }

  /**
   * Drive the `/model` picker, where Claude Code exposes reasoning effort:
   * ← / → adjust the level, Enter confirms, Esc backs out.
   *
   * The picker has to be open before an arrow means anything, and only this
   * side knows whether it is — so the open is issued here on the first nudge
   * rather than being a separate command the deck has to sequence. The armed
   * flag expires on its own because the user can also close the picker from the
   * keyboard, which we never see.
   */
  private handleSetEffort(action: 'increase' | 'decrease' | 'commit' | 'cancel'): void {
    const now = Date.now();
    const armed = now - this.effortPickerOpenedAt < ClaudeCodeAdapter.EFFORT_PICKER_TTL_MS;

    if (action === 'commit' || action === 'cancel') {
      if (!armed) {
        debug('adapter:claude', `set_effort: ${action} ignored — picker not open`);
        return;
      }
      // Enter confirms the highlighted level; Esc leaves it unchanged.
      this.ptyManager.write(action === 'commit' ? '\r' : '\x1b');
      this.effortPickerOpenedAt = 0;
      debug('adapter:claude', `set_effort: ${action}`);
      return;
    }

    const arrow = action === 'increase' ? '\x1b[C' : '\x1b[D';
    if (!armed) {
      debug('adapter:claude', 'set_effort: opening /model picker');
      this.ptyManager.write('/model\r');
      this.effortPickerOpenedAt = now;
      // The picker needs a beat to render before it will accept an arrow key.
      setTimeout(() => this.ptyManager.write(arrow), ClaudeCodeAdapter.EFFORT_PICKER_OPEN_DELAY_MS);
      return;
    }
    this.effortPickerOpenedAt = now; // each nudge extends the window
    this.ptyManager.write(arrow);
    debug('adapter:claude', `set_effort: ${action}`);
  }

  /**
   * Pre-seed the bridge-resolved (git-aware) project name so the parser's
   * PROJECT_DIR scrape never fires. The scrape is kept only as a fallback for
   * the rare case the resolver produced nothing meaningful.
   */
  seedProjectName(name: string): void {
    this.outputParser.seedProjectName(name);
  }

  override getProjectName(): string | null {
    return this.outputParser.getProjectName();
  }

  override prepareForNavigation(): void {
    this.outputParser.startInteractiveCooldown();
  }

  /** Exposed for SSE broadcasting from bridge index (alias for getHookServer) */
  getClaudeHookServer() {
    return this.getHookServer();
  }
}
