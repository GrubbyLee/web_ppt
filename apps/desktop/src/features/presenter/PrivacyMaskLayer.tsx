import type { PrivacyMask } from "@showit/contracts";

type PrivacyMaskLayerProps = {
  masks: PrivacyMask[];
  presenterPreview?: boolean;
};

export function PrivacyMaskLayer({ masks, presenterPreview = false }: PrivacyMaskLayerProps) {
  if (masks.length === 0) return null;
  return (
    <div className={`privacy-mask-layer ${presenterPreview ? "privacy-mask-layer--preview" : ""}`} aria-hidden="true">
      {masks.map((mask) => {
        const left = Math.min(mask.x1, mask.x2);
        const top = Math.min(mask.y1, mask.y2);
        return <span key={mask.id} className={`privacy-mask privacy-mask--${mask.mode}`} style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${Math.abs(mask.x2 - mask.x1) * 100}%`, height: `${Math.abs(mask.y2 - mask.y1) * 100}%` }} />;
      })}
    </div>
  );
}
