import { useState } from "preact/hooks";
import { api, ApiError, type Person } from "../api";
import { useAction } from "../hooks";
import { useI18n } from "../i18n";
import { ConnectionCode } from "./ConnectionCode";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { navigate } from "../router";

interface BaseProps {
  onClose(): void;
}

/** Cancel + the main button of a dialog. */
function Buttons({ busy, onClose, label, kind = "primary", disabled }: { busy: boolean; onClose(): void; label: string; kind?: "primary" | "destructive"; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <button type="button" class="btn" onClick={onClose} disabled={busy}>
        {t("common.cancel")}
      </button>
      <button type="submit" class={`btn ${kind === "destructive" ? "btn--destructive" : "btn--primary"}`} disabled={busy || disabled}>
        {label}
      </button>
    </>
  );
}

/** Add person: the name, then the connection code (text, QR, copy). */
export function AddPersonModal({ onClose, onCreated }: BaseProps & { onCreated(): void }) {
  const { t } = useI18n();
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ person: Person; code: string } | null>(null);

  if (created) {
    return (
      <Modal title={t("add.doneTitle", { name: created.person.name })} onClose={onClose} actions={
        <button type="button" class="btn btn--primary" onClick={onClose} data-autofocus>
          {t("common.done")}
        </button>
      }>
        <ConnectionCode code={created.code} />
      </Modal>
    );
  }
  return (
    <Modal
      title={t("add.title")}
      lead={t("add.lead")}
      onClose={onClose}
      busy={busy}
      onSubmit={async () => {
        const r = await run(() => api.addPerson(name.trim()));
        if (r.ok) {
          setCreated({ person: r.value.person, code: r.value.connectionCode });
          onCreated();
        }
      }}
      actions={<Buttons busy={busy} onClose={onClose} label={t("add.submit")} />}
    >
      <Field label={t("add.name")} value={name} onValue={setName} maxLength={80} autocomplete="off" required />
      <ErrorNote error={error} />
      {error instanceof ApiError && error.code === "address_not_set" ? (
        <p class="modal__text">
          <button
            type="button"
            class="btn"
            onClick={() => {
              onClose();
              navigate("/");
            }}
          >
            {t("add.goOverview")}
          </button>
        </p>
      ) : null}
    </Modal>
  );
}

/** Show the code again: the code is a credential, so the admin's password first. */
export function ShowCodeModal({ person, onClose }: BaseProps & { person: Person }) {
  const { t } = useI18n();
  const { busy, error, run } = useAction();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState<string | null>(null);

  if (code !== null) {
    return (
      <Modal title={t("code.title")} onClose={onClose} actions={
        <button type="button" class="btn btn--primary" onClick={onClose} data-autofocus>
          {t("common.done")}
        </button>
      }>
        <ConnectionCode code={code} />
      </Modal>
    );
  }
  return (
    <Modal
      title={t("showcode.title")}
      lead={t("showcode.lead")}
      small
      onClose={onClose}
      busy={busy}
      onSubmit={async () => {
        const r = await run(() => api.connectionCode(person.id, password));
        if (r.ok) {
          setPassword("");
          setCode(r.value.connectionCode);
        }
      }}
      actions={<Buttons busy={busy} onClose={onClose} label={t("showcode.submit")} />}
    >
      <Field label={t("common.password")} type="password" value={password} onValue={setPassword} autocomplete="current-password" required />
      <ErrorNote error={error} />
    </Modal>
  );
}

export function RenameModal({ person, onClose, onDone }: BaseProps & { person: Person; onDone(): void }) {
  const { t } = useI18n();
  const { busy, error, run } = useAction();
  const [name, setName] = useState(person.name);
  return (
    <Modal
      title={t("rename.title")}
      small
      onClose={onClose}
      busy={busy}
      onSubmit={async () => {
        if ((await run(() => api.renamePerson(person.id, name.trim()))).ok) {
          onDone();
          onClose();
        }
      }}
      actions={<Buttons busy={busy} onClose={onClose} label={t("rename.submit")} />}
    >
      <Field label={t("rename.name")} value={name} onValue={setName} maxLength={80} autocomplete="off" required />
      <ErrorNote error={error} />
    </Modal>
  );
}

/** A plain confirmation; blocking is reversible. */
export function BlockModal({ person, onClose, onDone }: BaseProps & { person: Person; onDone(): void }) {
  const { t } = useI18n();
  const { busy, error, run } = useAction();
  return (
    <Modal
      title={t("block.title", { name: person.name })}
      small
      onClose={onClose}
      busy={busy}
      onSubmit={async () => {
        if ((await run(() => api.setPersonState(person.id, "blocked"))).ok) {
          onDone();
          onClose();
        }
      }}
      actions={<Buttons busy={busy} onClose={onClose} label={t("block.submit")} kind="destructive" />}
    >
      <p class="modal__text">{t("block.text")}</p>
      <ErrorNote error={error} />
    </Modal>
  );
}

/** Deleting a person needs their name typed: it removes their data on the server for good. */
export function DeletePersonModal({ person, onClose, onDone }: BaseProps & { person: Person; onDone(): void }) {
  const { t } = useI18n();
  const { busy, error, run } = useAction();
  const [typed, setTyped] = useState("");
  return (
    <Modal
      title={t("delete.title", { name: person.name })}
      small
      onClose={onClose}
      busy={busy}
      onSubmit={async () => {
        if (typed.trim() !== person.name) return;
        if ((await run(() => api.deletePerson(person.id))).ok) {
          onDone();
          onClose();
        }
      }}
      actions={<Buttons busy={busy} onClose={onClose} label={t("delete.submit")} kind="destructive" disabled={typed.trim() !== person.name} />}
    >
      <p class="modal__text">{t("delete.text")}</p>
      <Field label={t("delete.type", { name: person.name })} value={typed} onValue={setTyped} autocomplete="off" autocapitalize="off" spellcheck={false} />
      <ErrorNote error={error} />
    </Modal>
  );
}

/** Unblocking needs no confirmation: it only restores. */
export async function unblock(person: Person): Promise<void> {
  await api.setPersonState(person.id, "active");
}

export type PersonDialog = { kind: "code" | "rename" | "block" | "delete"; person: Person };

/** The dialog that belongs to `dialog`, or nothing. */
export function PersonDialogs({ dialog, onClose, onChanged, onDeleted }: { dialog: PersonDialog | null; onClose(): void; onChanged(): void; onDeleted(): void }) {
  if (!dialog) return null;
  const { kind, person } = dialog;
  if (kind === "code") return <ShowCodeModal person={person} onClose={onClose} />;
  if (kind === "rename") return <RenameModal person={person} onClose={onClose} onDone={onChanged} />;
  if (kind === "block") return <BlockModal person={person} onClose={onClose} onDone={onChanged} />;
  return <DeletePersonModal person={person} onClose={onClose} onDone={onDeleted} />;
}
