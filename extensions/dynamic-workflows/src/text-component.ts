import type { Component } from "@oh-my-pi/pi-tui";

export class WorkflowTextComponent implements Component {
  #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  render(): string[] {
    return this.#text.split("\n");
  }

  invalidate(): void {}
}
