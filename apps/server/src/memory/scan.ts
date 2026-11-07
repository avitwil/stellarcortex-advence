// Static scan of a third-party skill before the owner approves it (FR-SKL-02): scripts, network
// calls, prompt-injection phrases and attempts to reach secrets. Findings are shown, never hidden;
// the owner decides.

export type FindingKind = 'script' | 'network' | 'prompt_injection' | 'secrets';
export interface Finding { kind: FindingKind; file: string; line: number; excerpt: string }

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|psm1|bat|cmd|go|rs|lua)$/i;

const RULES: { kind: Exclude<FindingKind, 'script'>; re: RegExp; scriptsOnly?: boolean }[] = [
  { kind: 'network', re: /\b(curl|wget|nc|ncat|netcat|socat|ssh|scp|rsync|ftp|telnet)\b\s|Invoke-WebRequest|Invoke-RestMethod|\bfetch\s*\(|XMLHttpRequest|\brequests\.(get|post|put|delete|patch|request)\b|urllib|http\.client|\bhttpx\b|\baxios\b|new\s+WebSocket|\bnet\.connect\b|\bsocket\.(socket|connect)\b|\/dev\/tcp\//i, scriptsOnly: true },
  { kind: 'network', re: /https?:\/\/(?!(www\.)?(agentskills\.io|github\.com\/[\w.-]+\/[\w.-]+\/?$))[^\s)'"`>]+/i },
  { kind: 'prompt_injection', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|guidelines?)\b|\byou are now\b|\bnew instructions?\s*:|\b(do not|don't|never)\s+(tell|inform|mention|reveal)[^.\n]{0,30}\b(user|owner|human)\b|\bsystem prompt\b|\bjailbreak\b|<\s*\/?\s*(system|assistant)\s*>|\bexfiltrat/i },
  { kind: 'secrets', re: /(~|\$HOME|%USERPROFILE%)\/?\.(ssh|aws|gnupg|config\/gcloud|kube|docker|netrc|npmrc|pypirc|git-credentials)\b|\bid_(rsa|ed25519|ecdsa)\b|\/etc\/(shadow|passwd|sudoers)\b|\.env\b|\b(process\.env|os\.environ|getenv|\$ENV\{|\$env:)|\b[A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\b|\b(keychain|keyring|credential manager|wallet\.dat|Login Data|cookies\.sqlite)\b|\bprintenv\b|\/proc\/[^/\s]+\/environ/i },
];

export function isScript(path: string, text: string): boolean {
  return SCRIPT_EXT.test(path) || text.startsWith('#!');
}

export function scanSkill(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    const script = isScript(file, text);
    if (script) out.push({ kind: 'script', file, line: 1, excerpt: text.split('\n')[0]!.slice(0, 160) });
    const lines = text.split('\n');
    for (const r of RULES) {
      if (r.scriptsOnly && !script) continue;
      let n = 0;
      for (let i = 0; i < lines.length && n < 20; i++) {
        if (!r.re.test(lines[i]!)) continue;
        out.push({ kind: r.kind, file, line: i + 1, excerpt: lines[i]!.trim().slice(0, 160) });
        n++;
      }
    }
  }
  return out;
}
