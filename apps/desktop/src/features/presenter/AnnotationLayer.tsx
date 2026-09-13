import { useMemo, useState } from "react";
import type { Circle, LaserPoint, PresentationSession, PrivacyMask } from "@showit/contracts";

type AnnotationLayerProps = {
  circles: Circle[];
  laser: LaserPoint | null;
  tool?: PresentationSession["annotationTool"];
  interactive?: boolean;
  onLaser?: (laser: LaserPoint | null) => void;
  onCircle?: (circle: Circle) => void;
  onMask?: (mask: PrivacyMask) => void;
};

function pointFromEvent(event: React.PointerEvent<SVGSVGElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  };
}

export function AnnotationLayer({
  circles,
  laser,
  tool = "none",
  interactive = false,
  onLaser,
  onCircle,
  onMask
}: AnnotationLayerProps) {
  const [draft, setDraft] = useState<Circle | null>(null);
  const activeCircles = useMemo(() => (draft ? [...circles, draft] : circles), [circles, draft]);
  const isInteractive = interactive && tool !== "none";

  return (
    <svg
      className={`annotation-layer ${isInteractive ? "is-interactive" : ""}`}
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
      onPointerDown={(event) => {
        if (!isInteractive || !["circle", "mask"].includes(tool)) return;
        const point = pointFromEvent(event);
        setDraft({ id: `circle-${Date.now().toString(36)}`, x1: point.x, y1: point.y, x2: point.x, y2: point.y });
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!isInteractive) return;
        const point = pointFromEvent(event);
        if (tool === "laser") {
          onLaser?.({ ...point, expiresAt: Date.now() + 700 });
          return;
        }
        if ((tool === "circle" || tool === "mask") && draft) {
          setDraft({ ...draft, x2: point.x, y2: point.y });
        }
      }}
      onPointerUp={(event) => {
        if (!isInteractive || !["circle", "mask"].includes(tool) || !draft) return;
        const point = pointFromEvent(event);
        const next = { ...draft, x2: point.x, y2: point.y };
        setDraft(null);
        if (Math.abs(next.x2 - next.x1) <= 0.015 || Math.abs(next.y2 - next.y1) <= 0.015) return;
        if (tool === "mask") onMask?.({ ...next, id: `mask-${Date.now().toString(36)}`, mode: "solid" });
        else onCircle?.(next);
      }}
      onPointerLeave={() => {
        if (tool === "laser") onLaser?.(null);
      }}
    >
      {activeCircles.map((circle) => {
        const x = Math.min(circle.x1, circle.x2);
        const y = Math.min(circle.y1, circle.y2);
        const width = Math.abs(circle.x2 - circle.x1);
        const height = Math.abs(circle.y2 - circle.y1);
        return (
          tool === "mask" && circle === draft ? <rect key={circle.id} className="annotation-layer__mask-draft" x={x} y={y} width={width} height={height} vectorEffect="non-scaling-stroke" /> : <ellipse
            key={circle.id}
            cx={x + width / 2}
            cy={y + height / 2}
            rx={width / 2}
            ry={height / 2}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {laser ? <circle className="annotation-layer__laser" cx={laser.x} cy={laser.y} r={0.015} /> : null}
    </svg>
  );
}
