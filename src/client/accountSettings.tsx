import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, KeyRound, ShieldCheck, Trash2, UserCheck, UserPlus, Users, UserX, Wand2 } from "lucide-react";
import { useAccess } from "./access";
import { api } from "./api";
import { Panel } from "./App";
import { formatDate, useUserPreferences } from "./appShared";
import { CopyButton } from "./copyButton";
import { eventDetail } from "./securityEventDetail";
import { minimumPasswordLength, securityEventLabel } from "../shared/auth";
import { manageableRoles, roleDescriptions, roleLabels, type AccountRecord, type AccountRole } from "../shared/permissions";

const accountsKey = ["accounts"] as const;
const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function generatePassword(length = 20): string {
  const values = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(values, (value) => passwordAlphabet[value % passwordAlphabet.length]).join("");
}

function TemporaryPasswordField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="account-password-field">
      Temporary password
      <span className="account-password-row">
        <input id={id} type="text" autoComplete="off" spellCheck={false} minLength={minimumPasswordLength} maxLength={256} required value={value} onChange={(event) => onChange(event.target.value)} />
        <button type="button" className="secondary" onClick={() => onChange(generatePassword())}><Wand2 size={16} />Generate</button>
        {value ? <CopyButton text={value} fallbackInputId={id} /> : null}
      </span>
    </label>
  );
}

function CreateAccountForm({ roles, onDone }: { roles: AccountRole[]; onDone: (message: string) => void }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<AccountRole>(roles.at(-1) ?? "moderator");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const create = useMutation({
    mutationFn: api.createAccount,
    onSuccess: (account) => {
      onDone(`Created ${account.username}. Share the temporary password privately. They must replace it when they first sign in.`);
      setUsername("");
      setTemporaryPassword("");
    }
  });
  return (
    <form className="account-form" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate({ username, role, temporaryPassword }); }}>
      <label>
        Username
        <input autoComplete="off" required maxLength={100} value={username} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <label>
        Role
        <select value={role} onChange={(event) => setRole(event.target.value as AccountRole)}>
          {roles.map((option) => <option key={option} value={option}>{roleLabels[option]}</option>)}
        </select>
        <small>{roleDescriptions[role]}</small>
      </label>
      <TemporaryPasswordField id="new-account-password" value={temporaryPassword} onChange={setTemporaryPassword} />
      {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
      <div><button type="submit" disabled={create.isPending}><UserPlus size={16} />Create account</button></div>
    </form>
  );
}

function accountStatus(account: AccountRecord): { label: string; className: string } {
  if (account.disabledAt) return { label: "Disabled", className: "pill pill-failed" };
  if (account.mustChangePassword) return { label: "Temporary password", className: "pill pill-running" };
  return { label: "Active", className: "pill pill-completed" };
}

function AccountRow({ account, roles, onChanged, onMessage }: { account: AccountRecord; roles: AccountRole[]; onChanged: () => void; onMessage: (message: string) => void }) {
  const { timeFormat } = useUserPreferences();
  const [mode, setMode] = useState<"idle" | "reset" | "delete">("idle");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const done = (message: string) => {
    onMessage(message);
    setMode("idle");
    setTemporaryPassword("");
    onChanged();
  };
  const changeRole = useMutation({ mutationFn: (role: AccountRole) => api.changeAccountRole(account.id, role), onSuccess: (_result, role) => done(`${account.username} is now ${roleLabels[role].toLowerCase()}. Their open sessions changed with it.`) });
  const setDisabled = useMutation({ mutationFn: (disabled: boolean) => (disabled ? api.disableAccount(account.id) : api.enableAccount(account.id)), onSuccess: (_result, disabled) => done(disabled ? `${account.username} is disabled and signed out everywhere.` : `${account.username} can sign in again.`) });
  const reset = useMutation({ mutationFn: () => api.resetAccountPassword(account.id, temporaryPassword), onSuccess: () => done(`Password reset for ${account.username}, who is now signed out everywhere and must replace it at next sign-in.`) });
  const remove = useMutation({ mutationFn: () => api.deleteAccount(account.id), onSuccess: () => done(`Deleted ${account.username}.`) });
  const error = changeRole.error ?? setDisabled.error ?? reset.error ?? remove.error;
  const busy = changeRole.isPending || setDisabled.isPending || reset.isPending || remove.isPending;
  const status = accountStatus(account);
  return (
    <li className="account-row" data-account={account.username}>
      <div className="account-row-summary">
        <strong>{account.username}{account.self ? <span className="pill pill-info security-current-pill">You</span> : null}</strong>
        <span className={`pill account-role account-role-${account.role}`}>{roleLabels[account.role]}</span>
        <span className={status.className}>{status.label}</span>
      </div>
      <p className="account-row-history">
        {account.createdBy ? `Created by ${account.createdBy}` : "Created at first-run setup"} on {formatDate(account.createdAt, timeFormat)}.
        {account.lastSignInAt ? ` Last signed in ${formatDate(account.lastSignInAt, timeFormat)}.` : " No sign-in recorded yet."}
        {account.disabledAt && account.disabledBy ? ` Disabled by ${account.disabledBy} on ${formatDate(account.disabledAt, timeFormat)}.` : ""}
      </p>
      {account.manageable ? (
        <div className="account-row-actions">
          <label className="account-role-select">
            <span className="sr-only">Role for {account.username}</span>
            <select value={account.role} disabled={busy} onChange={(event) => changeRole.mutate(event.target.value as AccountRole)}>
              {roles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
            </select>
          </label>
          <button type="button" className="secondary" disabled={busy} onClick={() => setMode(mode === "reset" ? "idle" : "reset")}><KeyRound size={15} />Reset password</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setDisabled.mutate(!account.disabledAt)}>
            {account.disabledAt ? <UserCheck size={15} /> : <UserX size={15} />}
            {account.disabledAt ? "Enable" : "Disable"}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setMode(mode === "delete" ? "idle" : "delete")}><Trash2 size={15} />Delete</button>
        </div>
      ) : null}
      {mode === "reset" ? (
        <form className="account-form account-inline-form" onSubmit={(event) => { event.preventDefault(); reset.mutate(); }}>
          <TemporaryPasswordField id={`reset-password-${account.id}`} value={temporaryPassword} onChange={setTemporaryPassword} />
          <div><button type="submit" disabled={busy}><KeyRound size={15} />Set temporary password</button></div>
        </form>
      ) : null}
      {mode === "delete" ? (
        <div className="account-inline-form">
          <p>Delete {account.username}? This cannot be undone. Their past activity stays in the logs.</p>
          <div className="account-row-actions">
            <button type="button" className="danger" disabled={busy} onClick={() => remove.mutate()}><Trash2 size={15} />Delete account</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setMode("idle")}>Cancel</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="error" role="alert">{error.message}</p> : null}
    </li>
  );
}

function TransferOwnershipPanel({ accounts, onDone }: { accounts: AccountRecord[]; onDone: (message: string) => void }) {
  const [targetId, setTargetId] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const candidates = accounts.filter((account) => !account.self && !account.disabledAt && !account.mustChangePassword);
  const target = candidates.find((account) => String(account.id) === targetId);
  const transfer = useMutation({
    mutationFn: () => api.transferOwnership(Number(targetId), currentPassword),
    onSuccess: () => {
      onDone(`${target?.username ?? "That account"} is now the owner. You are now an admin.`);
      setTargetId("");
      setCurrentPassword("");
    }
  });
  return (
    <Panel title="Transfer ownership" icon={<ArrowRightLeft size={18} />}>
      <div className="security-settings">
        <p className="section-settings-help">There is always exactly one owner. Transferring makes the chosen account the owner and leaves you an admin; the new owner would have to transfer it back.</p>
        {candidates.length === 0 ? (
          <p className="panel-message">No account can take ownership yet. It needs to be enabled and have replaced its temporary password.</p>
        ) : (
          <form className="account-form" onSubmit={(event) => { event.preventDefault(); transfer.mutate(); }}>
            <label>
              New owner
              <select required value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                <option value="">Choose an account</option>
                {candidates.map((account) => <option key={account.id} value={account.id}>{account.username} ({roleLabels[account.role]})</option>)}
              </select>
            </label>
            <label>
              Your current password
              <input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </label>
            {transfer.error ? <p className="error" role="alert">{transfer.error.message}</p> : null}
            <div><button type="submit" className="danger" disabled={transfer.isPending || !targetId || !currentPassword}><ArrowRightLeft size={16} />Transfer ownership</button></div>
          </form>
        )}
      </div>
    </Panel>
  );
}

export function AccountSettingsPanel() {
  const queryClient = useQueryClient();
  const { role, can } = useAccess();
  const { timeFormat } = useUserPreferences();
  const accounts = useQuery({ queryKey: accountsKey, queryFn: api.accounts });
  const [message, setMessage] = useState<string | null>(null);
  const roles = manageableRoles(role);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: accountsKey });
    void queryClient.invalidateQueries({ queryKey: ["security-events"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  };
  const announce = (text: string) => {
    setMessage(text);
    refresh();
  };
  const rows = accounts.data?.accounts ?? [];
  const activity = accounts.data?.activity ?? [];
  return (
    <>
      <Panel title="Accounts" icon={<Users size={18} />}>
        <div className="security-settings">
          <p className="section-settings-help">Your role is {roleLabels[role].toLowerCase()}. {roleDescriptions[role]} There is no self sign-up: an account exists only when someone here creates it.</p>
          {accounts.isLoading ? <p className="panel-message">Loading accounts...</p> : null}
          {accounts.error ? <p className="error" role="alert">{accounts.error.message}</p> : null}
          {message ? <p className="success" role="status">{message}</p> : null}
          {rows.length > 0 ? <ul className="account-list" aria-label="Accounts">{rows.map((account) => <AccountRow key={account.id} account={account} roles={roles} onChanged={refresh} onMessage={setMessage} />)}</ul> : null}
        </div>
      </Panel>
      <Panel title="Add an account" icon={<UserPlus size={18} />}>
        <div className="security-settings">
          <CreateAccountForm roles={roles} onDone={announce} />
        </div>
      </Panel>
      {can("ownership.transfer") ? <TransferOwnershipPanel accounts={rows} onDone={announce} /> : null}
      <Panel title="Recent account changes" icon={<ShieldCheck size={18} />}>
        <div className="security-settings">
          {activity.length === 0 ? <p className="panel-message">No account changes recorded yet.</p> : (
            <ul className="account-activity">
              {activity.map((event) => (
                <li key={event.id}>
                  <span>{formatDate(event.createdAt, timeFormat)}</span>
                  <span><strong>{event.username ?? "Unknown"}</strong> {securityEventLabel(event.event).toLowerCase()}{eventDetail(event) ? `: ${eventDetail(event)}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </>
  );
}
