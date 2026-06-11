import { createInterface } from "node:readline/promises";

/** Injectable prompt surface so the wizard's IO can be faked in tests. */
export interface Prompts {
  /** free-text input; returns the trimmed answer (or the default when empty). */
  input(question: string, defaultValue?: string): Promise<string>;
  /** yes/no; only y/yes (case-insensitive) is true. */
  confirm(question: string): Promise<boolean>;
  /** choose one of `choices` (1-based selection); returns the chosen string. */
  select(question: string, choices: string[]): Promise<string>;
}

const YES = new Set(["y", "yes"]);

/** Real adapter over node:readline/promises (TTY). */
export function readlinePrompts(): Prompts {
  const rl = () => createInterface({ input: process.stdin, output: process.stdout });
  return {
    async input(question, defaultValue) {
      const io = rl();
      try {
        const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
        const ans = (await io.question(`${question}${suffix} `)).trim();
        return ans === "" && defaultValue !== undefined ? defaultValue : ans;
      } finally {
        io.close();
      }
    },
    async confirm(question) {
      const io = rl();
      try {
        const ans = (await io.question(`${question} [y/N] `)).trim().toLowerCase();
        return YES.has(ans);
      } finally {
        io.close();
      }
    },
    async select(question, choices) {
      const io = rl();
      try {
        const list = choices.map((c, i) => `  ${i + 1}) ${c}`).join("\n");
        const ans = (await io.question(`${question}\n${list}\nchoose 1-${choices.length}: `)).trim();
        const idx = Number.parseInt(ans, 10) - 1;
        return choices[idx] ?? choices[0]!;
      } finally {
        io.close();
      }
    },
  };
}

/** Scripted fake: answers are dequeued in order; records questions asked. */
export function scriptedPrompts(answers: string[]): Prompts & { asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (q: string): string => {
    asked.push(q);
    if (queue.length === 0) throw new Error(`scriptedPrompts exhausted at: ${q}`);
    return queue.shift()!;
  };
  return {
    asked,
    async input(q, d) {
      const a = next(q);
      return a === "" && d !== undefined ? d : a;
    },
    async confirm(q) {
      return YES.has(next(q).trim().toLowerCase());
    },
    async select(q, choices) {
      const idx = Number.parseInt(next(q), 10) - 1;
      return choices[idx] ?? choices[0]!;
    },
  };
}
