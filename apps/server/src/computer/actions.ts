// Desktop actions for Bots: their own computer (FR-PC-01, FR-UI-05) and, with Host control on,
// the server's own desktop (D-12, FR-PC-09). Inputs are validated and passed to the commands as
// environment values, never spliced into a shell line.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ImagePart, ToolSpec } from '../models/types.js';

export const DesktopAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screenshot') }),
  z.object({ action: z.literal('click'), x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000), button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional() }),
  z.object({ action: z.literal('move'), x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000) }),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(5000) }),
  z.object({ action: z.literal('key'), keys: z.string().min(1).max(100).regex(/^[A-Za-z0-9_+\- ]+$/) }),
  z.object({ action: z.literal('scroll'), x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000), direction: z.enum(['up', 'down']), amount: z.number().int().min(1).max(30).optional() }),
  z.object({ action: z.literal('wait'), seconds: z.number().min(0.1).max(10) }),
]);
export type DesktopAction = z.infer<typeof DesktopAction>;

export function desktopToolSpec(name: string, what: string): ToolSpec {
  return {
    name,
    description:
      `${what} Actions: screenshot; click {x,y,button?,double?}; move {x,y}; type {text}; key {keys} (xdotool names, for example "ctrl+l", "Return", "ctrl+shift+t"); ` +
      'scroll {x,y,direction,amount?}; wait {seconds}. Every action except wait returns a fresh screenshot. Coordinates are screen pixels of the last screenshot.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'click', 'move', 'type', 'key', 'scroll', 'wait'] },
        x: { type: 'integer' }, y: { type: 'integer' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean' },
        text: { type: 'string' },
        keys: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'integer' },
        seconds: { type: 'number' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };
}

const BUTTON = { left: '1', middle: '2', right: '3' } as const;

/** One X11 action as an xdotool/ImageMagick shell script; values come from the environment. */
export function x11Script(a: DesktopAction): { script: string; env: Record<string, string> } {
  const shot = 'sleep 0.4; import -window root -quality 70 jpg:- | base64 -w0';
  switch (a.action) {
    case 'screenshot':
      return { script: 'import -window root -quality 70 jpg:- | base64 -w0', env: {} };
    case 'click':
      return { script: `xdotool mousemove --sync "$AX" "$AY" click --repeat "$AN" "$AB"; ${shot}`, env: { AX: String(a.x), AY: String(a.y), AN: a.double ? '2' : '1', AB: BUTTON[a.button ?? 'left'] } };
    case 'move':
      return { script: `xdotool mousemove --sync "$AX" "$AY"; ${shot}`, env: { AX: String(a.x), AY: String(a.y) } };
    case 'type':
      return { script: `xdotool type --delay 12 -- "$ATEXT"; ${shot}`, env: { ATEXT: a.text } };
    case 'key':
      // Validated to letters, digits, _ + - and spaces; split into separate key arguments.
      return { script: `xdotool key -- $AKEYS; ${shot}`, env: { AKEYS: a.keys } };
    case 'scroll':
      return { script: `xdotool mousemove --sync "$AX" "$AY" click --repeat "$AN" "$AB"; ${shot}`, env: { AX: String(a.x), AY: String(a.y), AN: String(a.amount ?? 3), AB: a.direction === 'up' ? '4' : '5' } };
    case 'wait':
      return { script: 'sleep "$AS"', env: { AS: String(a.seconds) } };
  }
}

export interface ActionResult { text: string; images?: ImagePart[]; isError?: boolean }

/** Turns the script's stdout (base64 JPEG for screenshots) into a tool result. */
export function actionResult(a: DesktopAction, code: number, stdout: string, stderr: string): ActionResult {
  if (code !== 0) return { text: `The ${a.action} action failed: ${stderr.trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`, isError: true };
  if (a.action === 'wait') return { text: 'Waited.' };
  const b64 = stdout.trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return { text: `${a.action} done (no screenshot).` };
  return { text: `${a.action} done.`, images: [{ type: 'image', mime: 'image/jpeg', dataB64: b64 }] };
}

// ------------------------------------------------------------------ host control (D-12)

/** Runs one action on the server's own desktop. Linux X11/Wayland, Windows and macOS. */
export async function hostAction(a: DesktopAction, signal: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<ActionResult> {
  if (platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) return run('sh', ['-c', waylandScript(a).script], waylandScript(a).env, a, signal);
    const { script, env } = x11Script(a);
    return run('sh', ['-c', script], env, a, signal);
  }
  if (platform === 'win32') {
    const { script, env } = windowsScript(a);
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], env, a, signal);
  }
  if (platform === 'darwin') {
    const { script, env } = macScript(a);
    return run('sh', ['-c', script], env, a, signal);
  }
  return { text: 'Host control is not supported on this operating system.', isError: true };
}

function run(cmd: string, args: string[], env: Record<string, string>, a: DesktopAction, signal: AbortSignal): Promise<ActionResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: 60_000 });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-2000)));
    p.on('error', (e) => resolve({ text: `The ${a.action} action failed: ${e.message}`, isError: true }));
    p.on('close', (code) => resolve(actionResult(a, code ?? -1, out, err)));
  });
}

/** Wayland: ydotool for input, grim for screenshots (wlroots compositors). */
export function waylandScript(a: DesktopAction): { script: string; env: Record<string, string> } {
  const shot = 'sleep 0.4; grim -t jpeg -q 70 - | base64 -w0';
  const KEYS: Record<string, string> = { Return: '28', Enter: '28', Tab: '15', Escape: '1', BackSpace: '14', space: '57', ctrl: '29', shift: '42', alt: '56', super: '125', Up: '103', Down: '108', Left: '105', Right: '106' };
  switch (a.action) {
    case 'screenshot':
      return { script: 'grim -t jpeg -q 70 - | base64 -w0', env: {} };
    case 'click':
    case 'move':
    case 'scroll': {
      const btn = a.action === 'click' ? ({ left: '0xC0', right: '0xC1', middle: '0xC2' } as const)[a.button ?? 'left'] : null;
      const click = btn ? ` && ydotool click ${a.action === 'click' && a.double ? '--repeat 2 ' : ''}"$AB"` : '';
      const wheel = a.action === 'scroll' ? ` && ydotool mousemove --wheel -x 0 -y "$AW"` : '';
      return { script: `ydotool mousemove --absolute -x "$AX" -y "$AY"${click}${wheel}; ${shot}`, env: { AX: String(a.x), AY: String(a.y), AB: btn ?? '', AW: a.action === 'scroll' ? String((a.direction === 'up' ? 1 : -1) * (a.amount ?? 3)) : '0' } };
    }
    case 'type':
      return { script: `ydotool type -- "$ATEXT"; ${shot}`, env: { ATEXT: a.text } };
    case 'key': {
      // ydotool takes key codes: press all, then release in reverse (for example ctrl+l).
      const seq = a.keys.split(' ').map((combo) => {
        const codes = combo.split('+').map((k) => KEYS[k] ?? (k.length === 1 && /[a-z]/i.test(k) ? String('qwertyuiop'.includes(k.toLowerCase()) ? 16 + 'qwertyuiop'.indexOf(k.toLowerCase()) : 'asdfghjkl'.includes(k.toLowerCase()) ? 30 + 'asdfghjkl'.indexOf(k.toLowerCase()) : 44 + 'zxcvbnm'.indexOf(k.toLowerCase())) : '57'));
        return [...codes.map((c) => `${c}:1`), ...codes.reverse().map((c) => `${c}:0`)].join(' ');
      });
      return { script: `ydotool key ${seq.join(' ')}; ${shot}`, env: {} };
    }
    case 'wait':
      return { script: 'sleep "$AS"', env: { AS: String(a.seconds) } };
  }
}

/** Windows: user32 input and a GDI+ screenshot through PowerShell. Values come from $env:. */
export function windowsScript(a: DesktopAction): { script: string; env: Record<string, string> } {
  const prelude =
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
    'Add-Type -Namespace Adv -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,int d,System.UIntPtr e); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'; ' +
    '[Adv.U]::SetProcessDPIAware() | Out-Null; ';
  const shot =
    'Start-Sleep -Milliseconds 400; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '$g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size); $m=New-Object System.IO.MemoryStream; ' +
    '$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Jpeg); [Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))';
  const down = { left: '0x0002', right: '0x0008', middle: '0x0020' } as const;
  const up = { left: '0x0004', right: '0x0010', middle: '0x0040' } as const;
  switch (a.action) {
    case 'screenshot':
      return { script: prelude + shot, env: {} };
    case 'click': {
      const b = a.button ?? 'left';
      const once = `[Adv.U]::mouse_event(${down[b]},0,0,0,[System.UIntPtr]::Zero); [Adv.U]::mouse_event(${up[b]},0,0,0,[System.UIntPtr]::Zero); `;
      return { script: `${prelude}[Adv.U]::SetCursorPos([int]$env:AX,[int]$env:AY) | Out-Null; ${once}${a.double ? once : ''}${shot}`, env: { AX: String(a.x), AY: String(a.y) } };
    }
    case 'move':
      return { script: `${prelude}[Adv.U]::SetCursorPos([int]$env:AX,[int]$env:AY) | Out-Null; ${shot}`, env: { AX: String(a.x), AY: String(a.y) } };
    case 'type':
      // SendKeys treats + ^ % ~ ( ) { } [ ] as commands; escape every one of them.
      return { script: `${prelude}$t=($env:ATEXT -replace '([+^%~(){}\\[\\]])','{$1}'); [System.Windows.Forms.SendKeys]::SendWait($t); ${shot}`, env: { ATEXT: a.text } };
    case 'key':
      return { script: `${prelude}[System.Windows.Forms.SendKeys]::SendWait($env:AKEYS); ${shot}`, env: { AKEYS: toSendKeys(a.keys) } };
    case 'scroll':
      return { script: `${prelude}[Adv.U]::SetCursorPos([int]$env:AX,[int]$env:AY) | Out-Null; [Adv.U]::mouse_event(0x0800,0,0,[int]$env:AW,[System.UIntPtr]::Zero); ${shot}`, env: { AX: String(a.x), AY: String(a.y), AW: String((a.direction === 'up' ? 120 : -120) * (a.amount ?? 3)) } };
    case 'wait':
      return { script: 'Start-Sleep -Milliseconds ([int]([double]$env:AS*1000))', env: { AS: String(a.seconds) } };
  }
}

/** xdotool-style key names ("ctrl+l Return") to SendKeys ("^l{ENTER}"). */
export function toSendKeys(keys: string): string {
  const NAMES: Record<string, string> = { Return: '{ENTER}', Enter: '{ENTER}', Tab: '{TAB}', Escape: '{ESC}', BackSpace: '{BACKSPACE}', Delete: '{DELETE}', Up: '{UP}', Down: '{DOWN}', Left: '{LEFT}', Right: '{RIGHT}', Home: '{HOME}', End: '{END}', Page_Up: '{PGUP}', Page_Down: '{PGDN}', space: ' ' };
  const MOD: Record<string, string> = { ctrl: '^', shift: '+', alt: '%' };
  return keys.split(' ').filter(Boolean).map((combo) => {
    const parts = combo.split('+');
    const key = parts.pop()!;
    const mods = parts.map((m) => MOD[m.toLowerCase()] ?? '').join('');
    const k = NAMES[key] ?? (/^F\d{1,2}$/.test(key) ? `{${key}}` : key.length === 1 ? key.toLowerCase() : '');
    return mods + k;
  }).join('');
}

/** macOS: screencapture plus CoreGraphics events through JavaScript for Automation (Accessibility). */
export function macScript(a: DesktopAction): { script: string; env: Record<string, string> } {
  const tmp = path.join(os.tmpdir(), 'advence-shot.jpg');
  const shot = `sleep 0.4; screencapture -x -t jpg "${tmp}" && base64 -i "${tmp}" | tr -d '\\n'; rm -f "${tmp}"`;
  const jxa = (body: string) => `osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); ObjC.import("stdlib"); const env=(k)=>$.getenv(k); ${body}'`;
  const mouse = (type: string, btn: string) => `$.CGEventPost(0,$.CGEventCreateMouseEvent(null,${type},{x:Number(env("AX")),y:Number(env("AY"))},${btn}));`;
  switch (a.action) {
    case 'screenshot':
      return { script: shot.replace('sleep 0.4; ', ''), env: {} };
    case 'click': {
      const [d, u, b] = a.button === 'right' ? [3, 4, 1] : a.button === 'middle' ? [25, 26, 2] : [1, 2, 0];
      const once = mouse(String(d), String(b)) + mouse(String(u), String(b));
      return { script: `${jxa(mouse('5', '0') + once + (a.double ? once : ''))}; ${shot}`, env: { AX: String(a.x), AY: String(a.y) } };
    }
    case 'move':
      return { script: `${jxa(mouse('5', '0'))}; ${shot}`, env: { AX: String(a.x), AY: String(a.y) } };
    case 'type':
      return { script: `osascript -e 'tell application "System Events" to keystroke (system attribute "ATEXT")'; ${shot}`, env: { ATEXT: a.text } };
    case 'key': {
      const CODES: Record<string, number> = { Return: 36, Enter: 36, Tab: 48, Escape: 53, BackSpace: 51, Delete: 117, space: 49, Up: 126, Down: 125, Left: 123, Right: 124 };
      const cmds = a.keys.split(' ').filter(Boolean).map((combo) => {
        const parts = combo.split('+');
        const key = parts.pop()!;
        const mods = parts.map((m) => ({ ctrl: 'control down', shift: 'shift down', alt: 'option down', super: 'command down', cmd: 'command down' })[m.toLowerCase()]).filter(Boolean);
        const using = mods.length ? ` using {${mods.join(', ')}}` : '';
        return CODES[key] !== undefined ? `key code ${CODES[key]}${using}` : `keystroke "${key.slice(0, 1).toLowerCase()}"${using}`;
      });
      return { script: `osascript ${cmds.map((c) => `-e 'tell application "System Events" to ${c}'`).join(' ')}; ${shot}`, env: {} };
    }
    case 'scroll':
      return { script: `${jxa(mouse('5', '0') + `$.CGEventPost(0,$.CGEventCreateScrollWheelEvent(null,0,1,${a.direction === 'up' ? '' : '-'}Number(env("AN"))));`)}; ${shot}`, env: { AX: String(a.x), AY: String(a.y), AN: String(a.amount ?? 3) } };
    case 'wait':
      return { script: 'sleep "$AS"', env: { AS: String(a.seconds) } };
  }
}

/** True when the host has what host control needs on Linux X11 (used by tests and Settings). */
export function hostToolsPresent(): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return ['xdotool', 'import'].every((b) => dirs.some((d) => fs.existsSync(path.join(d, b))));
}
