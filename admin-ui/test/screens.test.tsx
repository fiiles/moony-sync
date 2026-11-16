// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMock, loggedIn, openApp, overviewBody, person, setupDom } from "./setup";

const started: string[] = [];
vi.mock("../src/download", () => ({ startDownload: (url: string) => void started.push(url) }));
beforeEach(() => void (started.length = 0));

setupDom();

const type = (label: string | RegExp, value: string) =>
  fireEvent.input(screen.getByLabelText(label), { target: { value } });

describe("setup", () => {
  it("setup code, name and password lead to the overview", async () => {
    let state: any = { setupNeeded: true, authenticated: false, twoFactor: false, require2fa: false, mustEnrol2fa: false };
    const mock = installMock({
      "GET state": () => ({ json: state }),
      "POST setup": () => {
        state = loggedIn;
        return {};
      },
      "GET overview": () => ({ json: overviewBody() }),
    });
    openApp("/");
    await screen.findByRole("heading", { name: "Set up the server" });
    type("Setup code", "abc");
    type("Administrator name", "Filip");
    type("Password", "correct horse battery");
    type("Password again", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Set up the server" }));
    await screen.findByRole("heading", { name: "Overview" });
    expect(mock.calls.find((c) => c.path === "setup")?.body).toEqual({ code: "abc", name: "Filip", password: "correct horse battery" });
  });

  it("two different passwords are refused before any request", async () => {
    const mock = installMock({ "GET state": () => ({ json: { setupNeeded: true, authenticated: false, twoFactor: false, require2fa: false, mustEnrol2fa: false } }) });
    openApp("/");
    await screen.findByRole("heading", { name: "Set up the server" });
    type("Password", "correct horse battery");
    type("Password again", "correct horse batterx");
    fireEvent.click(screen.getByRole("button", { name: "Set up the server" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not the same");
    expect(mock.calls.some((c) => c.path === "setup")).toBe(false);
  });
});

describe("login", () => {
  it("asks for the second factor when the server says so, then reaches the overview", async () => {
    let state: any = { setupNeeded: false, authenticated: false, twoFactor: true, require2fa: false, mustEnrol2fa: false };
    const mock = installMock({
      "GET state": () => ({ json: state }),
      "POST login": (b) => {
        if (!b.totp) return { status: 401, json: { error: "totp_required" } };
        state = loggedIn;
        return {};
      },
      "GET overview": () => ({ json: overviewBody() }),
    });
    openApp("/");
    await screen.findByRole("heading", { name: "Log in" });
    type("Name", "Filip");
    type("Password", "pw-pw-pw-pw-pw");
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByRole("heading", { name: "Second factor" });
    expect(screen.queryByRole("alert")).toBeNull();
    type("Code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and log in" }));
    await screen.findByRole("heading", { name: "Overview" });
    const logins = mock.calls.filter((c) => c.path === "login");
    expect(logins[1]?.body).toEqual({ name: "Filip", password: "pw-pw-pw-pw-pw", totp: "123456" });
  });

  it("shows a translated message for a server error and a generic one for an unknown error", async () => {
    let next = { status: 401, json: { error: "bad_credentials" } as unknown };
    installMock({
      "GET state": () => ({ json: { setupNeeded: false, authenticated: false, twoFactor: false, require2fa: false, mustEnrol2fa: false } }),
      "POST login": () => next as any,
    });
    openApp("/");
    await screen.findByRole("heading", { name: "Log in" });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("name or password is not correct");
    next = { status: 500, json: { error: "something_new" } };
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Something went wrong"));
    expect(screen.getByRole("alert").textContent).not.toContain("something_new");
  });
});

describe("overview", () => {
  it("the first visit asks to confirm the suggested address", async () => {
    let address: string | null = null;
    const mock = installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET overview": () => ({ json: overviewBody({ address }) }),
      "PUT settings": (b) => {
        address = b.publicUrl;
        return { json: { publicUrl: address } };
      },
    });
    openApp("/");
    await screen.findByText("Confirm the address of this server");
    expect((screen.getByLabelText("Address apps use") as HTMLInputElement).value).toBe("http://localhost:8791");
    fireEvent.click(screen.getByRole("button", { name: "Use this address" }));
    await screen.findByText("Address for the app");
    expect(mock.calls.find((c) => c.method === "PUT")?.body).toEqual({ publicUrl: "http://localhost:8791" });
  });

  it("shows the four figures, the last sync with its absolute time in a title", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET overview": () => ({ json: overviewBody() }) });
    openApp("/");
    await screen.findByText("41 MB");
    expect(screen.getByText("1.6 TB free")).toBeTruthy();
    const time = document.querySelector("time")!;
    expect(time.textContent).toMatch(/4 min/);
    expect(time.getAttribute("title")).toMatch(/2026/);
  });
});

describe("people", () => {
  it("an empty list shows the empty state with an Add person button", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET people": () => ({ json: [] }) });
    openApp("/people");
    await screen.findByText("Nobody yet");
    expect(within(document.querySelector(".empty") as HTMLElement).getByRole("button", { name: "Add person" })).toBeTruthy();
  });

  it("adding a person ends on the connection code as text, a QR code and a copy button", async () => {
    const list: any[] = [];
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: list }),
      "POST people": (b) => {
        const p = person({ id: "p9", name: b.name });
        list.push(p);
        return { status: 201, json: { person: p, connectionCode: "moony-sync1:1234567890123456:aHR0cHM6Ly9zeW5jLmV4YW1wbGU" } };
      },
    });
    openApp("/people");
    await screen.findByText("Nobody yet");
    fireEvent.click(within(document.querySelector(".empty") as HTMLElement).getByRole("button", { name: "Add person" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Filip" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add person" }));
    const code = await screen.findByTestId("connection-code");
    expect(code.textContent).toMatch(/^moony-sync1:/);
    expect(within(dialog).getByRole("img", { name: "QR code with the connection code" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(dialog.textContent).toContain("Settings → Sync → Set up → Own server");
    expect(dialog.textContent).toContain("credential");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await screen.findByText("All people");
  });

  it("deleting a person needs their typed name", async () => {
    const mock = installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: [person()] }),
      "DELETE people/p1": () => ({}),
    });
    openApp("/people");
    await screen.findByText("All people");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete person" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.input(within(dialog).getByLabelText(/Type the name Anna/), { target: { value: "Ann" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.input(within(dialog).getByLabelText(/Type the name Anna/), { target: { value: "Anna" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mock.calls.some((c) => c.method === "DELETE" && c.path === "people/p1")).toBe(true);
  });

  it("showing the code again asks for the password first", async () => {
    const mock = installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: [person()] }),
      "POST people/p1/connection-code": (b) =>
        b.password === "right-password" ? { json: { connectionCode: "moony-sync1:1:aa" } } : { status: 401, json: { error: "bad_credentials" } },
    });
    openApp("/people");
    await screen.findByText("All people");
    fireEvent.click(screen.getByRole("button", { name: "Connection code" }));
    const dialog = await screen.findByRole("dialog");
    expect(screen.queryByTestId("connection-code")).toBeNull();
    fireEvent.input(within(dialog).getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Show code" }));
    await within(dialog).findByRole("alert");
    fireEvent.input(within(dialog).getByLabelText("Password"), { target: { value: "right-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Show code" }));
    expect((await screen.findByTestId("connection-code")).textContent).toBe("moony-sync1:1:aa");
    expect(mock.calls.filter((c) => c.path.endsWith("connection-code"))).toHaveLength(2);
  });

  it("blocking is a plain confirmation; Escape closes a dialog without acting", async () => {
    const mock = installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: [person()] }),
      "PATCH people/p1": (b) => ({ json: person({ state: b.state }) }),
    });
    openApp("/people");
    await screen.findByText("All people");
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mock.calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    const again = await screen.findByRole("dialog");
    fireEvent.click(within(again).getByRole("button", { name: "Block" }));
    await waitFor(() => expect(mock.calls.find((c) => c.method === "PATCH")?.body).toEqual({ state: "blocked" }));
  });

  it("a dialog moves focus in, keeps Tab inside, and gives focus back when it closes", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET people": () => ({ json: [person()] }) });
    openApp("/people");
    await screen.findByText("All people");
    const opener = screen.getByRole("button", { name: "Rename" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.tagName).toBe("INPUT");
    const submit = within(dialog).getByRole("button", { name: "Rename" });
    submit.focus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  it("buttons are disabled while the request is in flight", async () => {
    let release: () => void = () => undefined;
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: [person()] }),
      "PATCH people/p1": () => new Promise((r) => (release = () => r({ json: person({ state: "blocked" }) }))),
    });
    openApp("/people");
    await screen.findByText("All people");
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Block" }) as HTMLButtonElement;
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("person detail", () => {
  it("lists the profiles and deletes one after a confirmation", async () => {
    const mock = installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people/p1": () => ({ json: { ...person(), vaults: [{ id: "vault-id-1", shortId: "vaultA", bytes: 1024 * 1024, files: 0, lastActivity: null, kitSince: null, kitLastRead: null }] } }),
      "DELETE people/p1/vaults/vault-id-1": () => ({}),
    });
    openApp("/people/p1");
    await screen.findByText("vaultA");
    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mock.calls.some((c) => c.method === "DELETE" && c.path === "people/p1/vaults/vault-id-1")).toBe(true);
  });

  const kitVaults = [
    { id: "v1", shortId: "vaultA", bytes: 1024, files: 0, lastActivity: null, kitSince: 1_800_000_000, kitLastRead: null },
    { id: "v2", shortId: "vaultB", bytes: 1024, files: 0, lastActivity: null, kitSince: 1_800_000_000, kitLastRead: 1_800_086_400 },
    { id: "v3", shortId: "vaultC", bytes: 1024, files: 0, lastActivity: null, kitSince: null, kitLastRead: null },
  ];

  it("shows each profile's Recovery Kit: created, last used or never, or none", async () => {
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people/p1": () => ({ json: { ...person(), vaults: kitVaults } }),
    });
    openApp("/people/p1");
    await screen.findByText("vaultA");
    const created = new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(1_800_000_000 * 1000));
    const used = new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(1_800_086_400 * 1000));
    const text = document.body.textContent ?? "";
    expect(text).toContain(`Recovery kit: created ${created} · last used never`);
    expect(text).toContain(`Recovery kit: created ${created} · last used ${used}`);
    expect(text).toContain("Recovery kit: none");
    expect(text).toContain("the synced data of one Moony profile");
  });

  it("says it in Czech", async () => {
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people/p1": () => ({ json: { ...person(), vaults: kitVaults } }),
    });
    openApp("/people/p1", "cs");
    await screen.findByText("vaultA");
    const created = new Intl.DateTimeFormat("cs", { dateStyle: "medium" }).format(new Date(1_800_000_000 * 1000));
    const used = new Intl.DateTimeFormat("cs", { dateStyle: "medium" }).format(new Date(1_800_086_400 * 1000));
    const text = document.body.textContent ?? "";
    expect(text).toContain(`Záchranná sada: vytvořena ${created} · naposledy použita nikdy`);
    expect(text).toContain(`Záchranná sada: vytvořena ${created} · naposledy použita ${used}`);
    expect(text).toContain("Záchranná sada: žádná");
    expect(text).toContain("synchronizovaná data jednoho profilu Moony");
  });
});

describe("backup", () => {
  it("offers the download and says in plain words what restoring an older backup does", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET backup/size": () => ({ json: { estimatedBytes: 41943040 } }), });
    openApp("/backup", "cs");
    await screen.findByRole("heading", { name: "Záloha" });
    const link = screen.getByRole("link", { name: /Stáhnout zálohu/ });
    expect(link.getAttribute("href")).toBe("/admin/api/backup");
    expect(document.body.textContent).toContain("synchronizační server vrátil v čase");
    expect(document.body.textContent).toContain("nastavit synchronizaci znovu ze zařízení s nejúplnějšími daty");
    expect(document.body.textContent).toContain("Záchranná sada");
  });

  it("says the archive holds account numbers and the second-factor secret, not 'encrypted data only'", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET backup/size": () => ({ json: { estimatedBytes: 41943040 } }), });
    openApp("/backup");
    await screen.findByRole("heading", { name: "Backup" });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Keep this file private. Besides the encrypted data it holds each person's account number and the second-factor secret in readable form.");
    expect(text).not.toContain("encrypted data only");
    cleanup();
    openApp("/backup", "cs");
    await screen.findByRole("heading", { name: "Záloha" });
    const cs = document.body.textContent ?? "";
    expect(cs).toContain("Tento soubor uchovávejte v soukromí. Kromě šifrovaných dat obsahuje v čitelné podobě čísla účtů jednotlivých osob a tajný klíč druhého faktoru.");
    expect(cs).not.toContain("jen šifrovaná data");
  });

  it("says it in English too", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET backup/size": () => ({ json: { estimatedBytes: 41943040 } }), });
    openApp("/backup");
    await screen.findByRole("heading", { name: "Backup" });
    expect(document.body.textContent).toContain("the sync server went back");
    expect(document.body.textContent).toContain("set sync up again from the device with the most complete data");
  });
});

describe("settings", () => {
  it("switching the language changes the text and is remembered", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET overview": () => ({ json: overviewBody() }), "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }), });
    openApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getAllByRole("button", { name: "Čeština" })[0]!);
    await screen.findByRole("heading", { name: "Nastavení" });
    expect(localStorage.getItem("moony-sync-lang")).toBe("cs");
    expect(document.documentElement.lang).toBe("cs");
  });

  it("changing the password sends current and new, and confirms", async () => {
    const mock = installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }),
      "POST password": () => ({}),
    });
    openApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    type("Current password", "old-old-old-old");
    type("New password", "new-new-new-new");
    type("New password again", "new-new-new-new");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByText(/The password was changed/);
    expect(mock.calls.find((c) => c.path === "password")?.body).toEqual({ current: "old-old-old-old", next: "new-new-new-new" });
  });

  it("hides turning the second factor off when the server requires it", async () => {
    installMock({
      "GET state": () => ({ json: { ...loggedIn, twoFactor: true, require2fa: true } }),
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }),
    });
    openApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
  });
});

describe("blob quota, files and backup size", () => {
  const settingsMock = (mock: Record<string, any> = {}) =>
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10 * 1024 ** 3 } }),
      "PUT settings": (b) => ({ json: b }),
      ...mock,
    });

  it("settings: the quota field shows GiB and saves bytes", async () => {
    const mock = settingsMock();
    openApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() => expect((screen.getByLabelText("Per profile (GiB)") as HTMLInputElement).value).toBe("10"));
    type("Per profile (GiB)", "25");
    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
    await screen.findByText("The limit was saved.");
    expect(mock.calls.find((c) => c.method === "PUT" && c.path === "settings")?.body).toEqual({ blobQuotaBytes: 25 * 1024 ** 3 });
  });

  it("settings: a quota that is not a whole number is refused before any request", async () => {
    const mock = settingsMock();
    openApp("/settings");
    await waitFor(() => expect((screen.getByLabelText("Per profile (GiB)") as HTMLInputElement).value).toBe("10"));
    for (const bad of ["2.5", "", "1048577", "-1"]) {
      type("Per profile (GiB)", bad);
      fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
      expect((await screen.findByRole("alert")).textContent).toContain("whole number of GiB");
    }
    expect(mock.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("person detail shows each profile's file count", async () => {
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people/p1": () => ({ json: { ...person(), vaults: [{ id: "v1", shortId: "vaultA", bytes: 1024, files: 3, lastActivity: null, kitSince: null, kitLastRead: null }] } }),
    });
    openApp("/people/p1");
    await screen.findByText("vaultA");
    expect(screen.getByRole("columnheader", { name: "Files" })).toBeTruthy();
    expect(screen.getByText("3").getAttribute("data-label")).toBe("Files");
  });

  it("backup shows the estimated size, in Czech too", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET backup/size": () => ({ json: { estimatedBytes: 1.2 * 1024 ** 3 } }) });
    openApp("/backup");
    await screen.findByText(/Estimated size: 1\.2 GB/);
    cleanup();
    openApp("/backup", "cs");
    await screen.findByText(/Odhadovaná velikost: 1,2 GB/);
  });

  it("backup says nothing about a size when it cannot be loaded", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET backup/size": () => ({ status: 500, json: { error: "x" } }) });
    openApp("/backup");
    await screen.findByRole("heading", { name: "Backup" });
    await screen.findByText("Documents and photos are in the archive too, so it can be large.");
    expect(document.body.textContent).not.toContain("Estimated size");
  });
});

describe("forced second factor enrolment", () => {
  it("is the only screen until the factor exists, then shows the backup codes once", async () => {
    let state: any = { ...loggedIn, require2fa: true, mustEnrol2fa: true };
    const mock = installMock({
      "GET state": () => ({ json: state }),
      "POST 2fa/enrol": () => ({ json: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Moony:Filip?secret=JBSWY3DPEHPK3PXP&issuer=Moony" } }),
      "POST 2fa/confirm": () => {
        return { json: { backupCodes: ["AAAAAAAAAA", "BBBBBBBBBB"] } };
      },
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }),
    });
    openApp("/");
    await screen.findByRole("heading", { name: "Set up the second factor" });
    expect(screen.queryByRole("navigation")).toBeNull();
    type("Password", "pw-pw-pw-pw-pw");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByTestId("totp-secret");
    expect(screen.getByRole("img", { name: "QR code for the authenticator app" })).toBeTruthy();
    type("6-digit code from the app", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const codes = await screen.findByTestId("backup-codes");
    expect(codes.textContent).toContain("AAAAAAAAAA");
    state = { ...loggedIn, twoFactor: true, require2fa: true, mustEnrol2fa: false };
    fireEvent.click(screen.getByRole("button", { name: "I saved the codes" }));
    await screen.findByRole("heading", { name: "Overview" });
    expect(mock.calls.find((c) => c.path === "2fa/enrol")?.body).toEqual({ password: "pw-pw-pw-pw-pw" });
  });
});

describe("session loss", () => {
  it("a 401 from any call returns to the login screen", async () => {
    let state: any = loggedIn;
    installMock({
      "GET state": () => ({ json: state }),
      "GET overview": () => {
        state = { setupNeeded: false, authenticated: false, twoFactor: false, require2fa: false, mustEnrol2fa: false };
        return { status: 401, json: { error: "unauthorized" } };
      },
    });
    openApp("/");
    await screen.findByRole("heading", { name: "Log in" });
  });
});

describe("navigation", () => {
  it("links move between pages without reloading and mark the current one", async () => {
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }),
      "GET people": () => ({ json: [person()] }),
    });
    openApp("/");
    await screen.findByRole("heading", { name: "Overview" });
    fireEvent.click(screen.getByRole("link", { name: "People" }));
    await screen.findByText("All people");
    expect(window.location.pathname).toBe("/people");
    expect(screen.getByRole("link", { name: "People" }).getAttribute("aria-current")).toBe("page");
  });

  it("an unknown path shows a not-found page", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET backup/size": () => ({ json: { estimatedBytes: 41943040 } }), });
    openApp("/nowhere");
    await screen.findByRole("heading", { name: "This page does not exist" });
  });
});

describe("copy button", () => {
  const openCode = async () => {
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: [person()] }),
      "POST people/p1/connection-code": () => ({ json: { connectionCode: "moony-sync1:1:aa" } }),
    });
    openApp("/people");
    await screen.findByText("All people");
    fireEvent.click(screen.getByRole("button", { name: "Connection code" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Password"), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Show code" }));
    await screen.findByTestId("connection-code");
    return dialog;
  };

  it("uses the clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const dialog = await openCode();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    await within(dialog).findByText("Copied");
    expect(writeText).toHaveBeenCalledWith("moony-sync1:1:aa");
  });

  it("on a plain-http page (no navigator.clipboard) falls back to a textarea and execCommand", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    let copied = "";
    document.execCommand = vi.fn((cmd: string) => {
      copied = (document.querySelector("textarea.copy-sink") as HTMLTextAreaElement | null)?.value ?? "";
      return cmd === "copy";
    });
    const dialog = await openCode();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    await within(dialog).findByText("Copied");
    expect(copied).toBe("moony-sync1:1:aa");
    expect(document.querySelector("textarea.copy-sink")).toBeNull();
  });

  it("when both fail it says to select the text and copy it by hand", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    document.execCommand = vi.fn(() => false);
    const dialog = await openCode();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    await within(dialog).findByText("Select the text and copy it manually");
    expect(within(dialog).queryByText("Copied")).toBeNull();
  });
});

describe("backup codes cannot be dismissed", () => {
  const enrolMocks = () =>
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }),
      "POST 2fa/enrol": () => ({ json: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" } }),
      "POST 2fa/confirm": () => ({ json: { backupCodes: ["AAAAAAAAAA"] } }),
    });

  it("in Settings, neither Escape nor a close button ends the codes step; the explicit button does", async () => {
    enrolMocks();
    openApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Set up second factor" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy(); // closable before the codes
    type("Password", "pw-pw-pw-pw-pw");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await within(dialog).findByTestId("totp-secret");
    type("6-digit code from the app", "123456");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await within(dialog).findByTestId("backup-codes");
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "I saved the codes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("in Settings the dialog cannot be closed from the moment the confirm request starts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }),
      "POST 2fa/enrol": () => ({ json: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" } }),
      "POST 2fa/confirm": async () => {
        await gate;
        return { json: { backupCodes: ["AAAAAAAAAA"] } };
      },
    });
    openApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Set up second factor" }));
    const dialog = await screen.findByRole("dialog");
    type("Password", "pw-pw-pw-pw-pw");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await within(dialog).findByTestId("totp-secret");
    type("6-digit code from the app", "123456");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    release();
    await within(dialog).findByTestId("backup-codes");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "I saved the codes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a second submit of the confirm form while the first runs does not unlock the dialog", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let confirms = 0;
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }),
      "POST 2fa/enrol": () => ({ json: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" } }),
      "POST 2fa/confirm": async () => {
        confirms += 1;
        await gate;
        return { json: { backupCodes: ["AAAAAAAAAA"] } };
      },
    });
    openApp("/settings");
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Set up second factor" }));
    const dialog = await screen.findByRole("dialog");
    type("Password", "pw-pw-pw-pw-pw");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await within(dialog).findByTestId("totp-secret");
    type("6-digit code from the app", "123456");
    const form = within(dialog).getByRole("button", { name: "Confirm" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 20));
    expect((within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    release();
    await within(dialog).findByTestId("backup-codes");
    expect(confirms).toBe(1);
  });

  it("in the forced enrolment the log out link is gone once the codes are shown", async () => {
    installMock({
      "GET state": () => ({ json: { ...loggedIn, require2fa: true, mustEnrol2fa: true } }),
      "POST 2fa/enrol": () => ({ json: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" } }),
      "POST 2fa/confirm": () => ({ json: { backupCodes: ["AAAAAAAAAA"] } }),
    });
    openApp("/");
    await screen.findByRole("heading", { name: "Set up the second factor" });
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
    type("Password", "pw-pw-pw-pw-pw");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByTestId("totp-secret");
    type("6-digit code from the app", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByTestId("backup-codes");
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });
});

describe("double submit", () => {
  it("two synchronous submits of Add person make one request", async () => {
    const mock = installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: [] }),
      "POST people": async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { status: 201, json: { person: person({ name: "Filip" }), connectionCode: "moony-sync1:1:aa" } };
      },
    });
    openApp("/people");
    await screen.findByText("Nobody yet");
    fireEvent.click(within(document.querySelector(".empty") as HTMLElement).getByRole("button", { name: "Add person" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Filip" } });
    const form = dialog.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByTestId("connection-code");
    expect(mock.calls.filter((c) => c.method === "POST" && c.path === "people")).toHaveLength(1);
  });
});

describe("add person without an address", () => {
  it("offers a way to the Overview", async () => {
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: [] }),
      "POST people": () => ({ status: 409, json: { error: "address_not_set" } }),
      "GET overview": () => ({ json: overviewBody() }),
      "GET settings": () => ({ json: { publicUrl: null, blobQuotaBytes: 10737418240 } }),
    });
    openApp("/people");
    await screen.findByText("Nobody yet");
    fireEvent.click(within(document.querySelector(".empty") as HTMLElement).getByRole("button", { name: "Add person" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Filip" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add person" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Go to Overview" }));
    await screen.findByRole("heading", { name: "Overview" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname).toBe("/");
  });
});

describe("backup download", () => {
  it("checks the session first and goes to login instead of downloading when it is gone", async () => {
    let state: any = loggedIn;
    installMock({ "GET state": () => ({ json: state }) });
    openApp("/backup");
    const link = await screen.findByRole("link", { name: /Download backup/ });
    state = { setupNeeded: false, authenticated: false, twoFactor: false, require2fa: false, mustEnrol2fa: false };
    fireEvent.click(link);
    await screen.findByRole("heading", { name: "Log in" });
    expect(started).toEqual([]);
  });

  it("starts the download when the session is alive", async () => {
    installMock({ "GET state": () => ({ json: loggedIn }), "GET backup/size": () => ({ json: { estimatedBytes: 41943040 } }), });
    openApp("/backup");
    fireEvent.click(await screen.findByRole("link", { name: /Download backup/ }));
    await waitFor(() => expect(started).toEqual(["/admin/api/backup"]));
  });

  it("a second click while the state check runs does nothing: no extra check, no refresh, one download", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stateCalls = 0;
    installMock({
      "GET state": async () => {
        stateCalls += 1;
        if (stateCalls > 1) await gate; // the first check (after the initial load) is slow
        return { json: loggedIn };
      },
    });
    openApp("/backup");
    const link = await screen.findByRole("link", { name: /Download backup/ });
    expect(stateCalls).toBe(1);
    fireEvent.click(link);
    fireEvent.click(link);
    release();
    await waitFor(() => expect(started).toEqual(["/admin/api/backup"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(stateCalls).toBe(2); // the initial load and the one check; the second click added none
    expect(started).toHaveLength(1);
  });
});

describe("refresh button", () => {
  it("the overview shows new figures after Refresh without a reload", async () => {
    let profiles = 0;
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET overview": () => ({ json: overviewBody({ profiles }) }),
    });
    openApp("/");
    await screen.findByRole("heading", { name: "Overview" });
    profiles = 5;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText("5")).toBeTruthy());
  });

  it("People has a Refresh button and Czech label", async () => {
    installMock({
      "GET state": () => ({ json: loggedIn }),
      "GET people": () => ({ json: [person()] }),
    });
    openApp("/people", "cs");
    await screen.findByRole("button", { name: "Obnovit" });
  });
});
