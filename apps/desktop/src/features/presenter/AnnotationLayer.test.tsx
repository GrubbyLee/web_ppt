import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationLayer } from "./AnnotationLayer";

describe("AnnotationLayer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a pixel-stable laser cursor and publishes normalized coordinates", () => {
    const onLaser = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { container, rerender } = render(
      <AnnotationLayer circles={[]} laser={null} tool="laser" interactive onLaser={onLaser} />
    );
    const layer = container.querySelector(".annotation-layer") as HTMLDivElement;
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ left: 100, top: 200, width: 400, height: 200 } as DOMRect);

    fireEvent.pointerMove(layer, { clientX: 200, clientY: 250 });
    expect(onLaser).toHaveBeenCalledWith({ x: 0.25, y: 0.25, expiresAt: 1_700 });
    expect(layer).toHaveClass("is-laser");

    rerender(<AnnotationLayer circles={[]} laser={{ x: 0.25, y: 0.5, expiresAt: 1_700 }} tool="laser" interactive onLaser={onLaser} />);
    const cursor = container.querySelector(".annotation-layer__laser") as HTMLSpanElement;
    expect(cursor).toHaveStyle({ left: "25%", top: "50%" });

    fireEvent.pointerLeave(layer);
    expect(onLaser).toHaveBeenLastCalledWith(null);
  });
});
