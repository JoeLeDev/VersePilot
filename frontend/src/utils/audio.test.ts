import { describe, expect, it } from "vitest";
import {
  float32ToInt16Bytes,
  formatCaptureError,
  resampleFloat32,
} from "./audio";

describe("resampleFloat32", () => {
  it("renvoie l'entrée si les taux sont égaux", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleFloat32(input, 16000, 16000)).toBe(input);
  });
  it("réduit la longueur en downsampling", () => {
    const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]);
    const out = resampleFloat32(input, 16000, 8000);
    expect(out.length).toBe(4);
  });
});

describe("float32ToInt16Bytes", () => {
  it("convertit et clippe vers PCM16", () => {
    const out = float32ToInt16Bytes(new Float32Array([0, 1, -1, 2, -2]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0x7fff);
    expect(out[2]).toBe(-0x8000);
    expect(out[3]).toBe(0x7fff); // clip > 1
    expect(out[4]).toBe(-0x8000); // clip < -1
  });
});

describe("formatCaptureError", () => {
  it("gère le refus de permission", () => {
    expect(formatCaptureError({ name: "NotAllowedError" })).toMatch(/refusé|annulé/i);
  });
  it("gère l'annulation", () => {
    expect(formatCaptureError({ name: "AbortError" })).toBe("Capture annulée.");
  });
  it("renvoie le message brut par défaut", () => {
    expect(formatCaptureError({ message: "boom" })).toBe("boom");
  });
});
