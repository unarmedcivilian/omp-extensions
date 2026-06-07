import { describe, expect, test } from "bun:test";
import { CmuxWidgetSurface, LocalWidgetServer } from "../src/surface.js";

describe("LocalWidgetServer", () => {
  test("serves runtime HTML for registered widget tokens", async () => {
    const server = new LocalWidgetServer("<!doctype html><title>Widget</title>");
    const surface = new CmuxWidgetSurface("tok", () => {});

    try {
      const url = server.register(surface);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>Widget</title>");
    } finally {
      server.close();
    }
  });

  test("serves the widget title instead of the placeholder browser title", async () => {
    const server = new LocalWidgetServer("<!doctype html><title>Widget</title><div>runtime</div>");
    const surface = new CmuxWidgetSurface("tok", () => {}, "design iteration");

    try {
      const url = server.register(surface);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>design iteration</title>");
    } finally {
      server.close();
    }
  });

  test("returns 404 for unknown widget tokens", async () => {
    const server = new LocalWidgetServer("runtime");

    try {
      const base = server.baseUrl;
      const response = await fetch(new URL("/widget/missing", base));

      expect(response.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
