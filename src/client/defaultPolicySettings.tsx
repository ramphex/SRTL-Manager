import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Save, X } from "lucide-react";
import type { DefaultPolicyApplyResult, DefaultPolicyPreview, DefaultStoragePolicy, SectionSettings } from "../shared/types";
import { api } from "./api";
import { formatNumber, storagePolicyLabel, useModalLifecycle, useStorageLocations } from "./appShared";

type DraftPolicy = DefaultStoragePolicy | "none";

function draftsFromSettings(settings: SectionSettings): Record<string, DraftPolicy> {
  return Object.fromEntries(settings.sections.map((section) => [section, settings.sectionDefaultPolicies?.[section] ?? "none"]));
}

function ApplyDefaultDialog({ preview, policyName, result, error, isPending, onClose, onConfirm }: {
  preview: DefaultPolicyPreview | null;
  policyName: string;
  result: DefaultPolicyApplyResult | null;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useModalLifecycle(Boolean(preview), onClose);
  if (!preview) return null;
  const count = preview.unassignedTitles;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog terminate-dialog" role="dialog" aria-modal="true" aria-labelledby="apply-default-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">Default policy</span>
            <h2 id="apply-default-title">Apply to unassigned titles in {preview.section}</h2>
            {result ? (
              <p>
                Assigned {policyName} to {formatNumber(result.assigned)} title{result.assigned === 1 ? "" : "s"}.
                {result.skippedForRadarrReview > 0 ? ` ${formatNumber(result.skippedForRadarrReview)} left for Radarr review.` : ""}
              </p>
            ) : (
              <p>
                {count === 0
                  ? "There are no unassigned titles in this folder."
                  : `${formatNumber(count)} unassigned title${count === 1 ? "" : "s"} will be assigned ${policyName}. Titles that already have a policy are not changed.`}
                {preview.radarrReviewTitles > 0 ? ` ${formatNumber(preview.radarrReviewTitles)} more carry the opposite Radarr tag and stay unassigned for review.` : ""}
              </p>
            )}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close apply default policy" disabled={isPending}>
            <X size={18} />
          </button>
        </div>
        {!result && count > 0 ? <p className="section-settings-help">No copy jobs start. Titles assigned the first location appear as Copy to {policyName} candidates only when their files are on the other location.</p> : null}
        {error ? <p className="panel-message action-error">{error}</p> : null}
        <div className="terminate-dialog-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={isPending}>
            {result ? "Close" : "Cancel"}
          </button>
          {!result ? (
            <button type="button" onClick={onConfirm} disabled={isPending || count === 0}>
              <CheckCircle2 size={16} />
              Assign {formatNumber(count)} title{count === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function DefaultPolicySettings({ settings }: { settings: SectionSettings }) {
  const queryClient = useQueryClient();
  const locations = useStorageLocations();
  const [drafts, setDrafts] = useState<Record<string, DraftPolicy>>(() => draftsFromSettings(settings));
  const [preview, setPreview] = useState<DefaultPolicyPreview | null>(null);
  const [applied, setApplied] = useState<DefaultPolicyApplyResult | null>(null);
  useEffect(() => setDrafts(draftsFromSettings(settings)), [settings]);

  const localName = storagePolicyLabel("location_1", locations);
  const remoteName = storagePolicyLabel("location_2", locations);
  const dirty = settings.sections.some((section) => drafts[section] !== (settings.sectionDefaultPolicies?.[section] ?? "none"));
  const save = useMutation({
    mutationFn: () => {
      const sectionDefaultPolicies = Object.fromEntries(
        settings.sections.flatMap((section) => (drafts[section] === "location_1" || drafts[section] === "location_2" ? [[section, drafts[section]]] : []))
      );
      return api.saveSections({ ...settings, sectionDefaultPolicies });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["section-settings"] })
  });
  const loadPreview = useMutation({
    mutationFn: (section: string) => api.defaultPolicyPreview(section),
    onSuccess: (next) => {
      setApplied(null);
      setPreview(next);
    }
  });
  const apply = useMutation({
    mutationFn: (section: string) => api.applyDefaultPolicy(section),
    onSuccess: (result) => {
      setApplied(result);
      queryClient.invalidateQueries({ queryKey: ["storage-policies"] });
      queryClient.invalidateQueries({ queryKey: ["media-links"] });
      queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
      queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
      queryClient.invalidateQueries({ queryKey: ["sections"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
    }
  });
  const closeDialog = () => {
    setPreview(null);
    setApplied(null);
    apply.reset();
  };

  return (
    <div className="section-settings">
      <p className="section-settings-help">
        Titles that first appear in a folder after you save a default (for example when Seerr requests them and Radarr or Sonarr imports them) get that storage policy automatically.
        Existing titles and titles that already have a policy are never changed. Titles assigned {localName} show up as Copy to {localName} candidates; nothing is copied until you start a copy.
      </p>
      <div className="location-settings-list">
        {settings.sections.map((section) => {
          const saved = settings.sectionDefaultPolicies?.[section] ?? null;
          return (
            <div className="default-policy-row" key={section}>
              <span className="default-policy-name">{settings.sectionTitles?.[section] ?? section}</span>
              <select aria-label={`Default policy for new titles in ${section}`} value={drafts[section] ?? "none"} onChange={(event) => setDrafts((current) => ({ ...current, [section]: event.target.value as DraftPolicy }))}>
                <option value="none">None (leave unassigned)</option>
                <option value="location_1">{localName} (Location 1)</option>
                <option value="location_2">{remoteName} (Location 2)</option>
              </select>
              <button
                type="button"
                className="secondary"
                disabled={!saved || drafts[section] !== saved || loadPreview.isPending}
                title={saved ? "Assign the saved default to titles in this folder that have no policy" : "Save a default policy for this folder first"}
                onClick={() => loadPreview.mutate(section)}
              >
                Apply to unassigned titles now
              </button>
            </div>
          );
        })}
      </div>
      {loadPreview.error ? <p className="panel-message action-error">{loadPreview.error.message}</p> : null}
      {save.error ? <p className="panel-message action-error">{save.error.message}</p> : null}
      <div className="section-settings-actions">
        <button type="button" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          <Save size={16} />
          Save default policies
        </button>
      </div>
      <ApplyDefaultDialog
        preview={preview}
        policyName={preview ? storagePolicyLabel(preview.policy, locations) : ""}
        result={applied}
        error={apply.error?.message}
        isPending={apply.isPending}
        onClose={closeDialog}
        onConfirm={() => preview && apply.mutate(preview.section)}
      />
    </div>
  );
}
