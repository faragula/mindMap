# MindPages

Webová verze MindMap pro GitHub Pages. Stejné plátno, uzly, vazby, zóny a
vnořené zóny jako prototyp, ale plány se ukládají do Supabase, takže se
otevřou z libovolného zařízení.

## Jak to funguje

- **Hosting:** statický build (Vite) na GitHub Pages.
- **Data:** Supabase, stejný projekt jako MindMap, ale **vlastní tabulka
  `mindpages_plans`**. Tabulka MindMapu zůstává nedotčená.
- **Přihlášení:** jeden účet v Supabase Auth. E-mail je v konfiguraci,
  na každém zařízení zadáváš jen heslo. Ověření dělá server, takže heslo
  není součástí bundlu.
- **Relace:** tokeny jsou v `localStorage` prohlížeče, access token se
  automaticky obnovuje. Tlačítko „Zamknout“ relaci smaže.

## 1. Supabase

### Účet

1. Otevři svůj projekt v [Supabase](https://supabase.com/dashboard).
2. **Authentication → Users → Add user**.
3. Zadej e-mail a heslo, zaškrtni **Auto Confirm User**.
4. Tento e-mail patří do `VITE_AUTH_EMAIL`, heslo si nech pro sebe.

> Pokud už účet máš, krok přeskoč.

### Tabulka

1. **SQL Editor → New query**.
2. Vlož celý obsah `db/mindpages-plans.sql` a spusť.
3. Skript je bezpečné spustit opakovaně.

Tabulka má RLS: řádek vidí a mění jen jeho vlastník (`auth.uid()`), takže
anon klíč sám o sobě nic nepřečte.

## 2. Lokální vývoj

```bash
npm install
copy .env.example .env.local
```

Do `.env.local` doplň:

```env
VITE_SUPABASE_URL=https://tvuj-projekt.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
VITE_AUTH_EMAIL=ty@example.com
```

`VITE_AUTH_EMAIL` může zůstat prázdný — formulář se pak na e-mail zeptá.
Heslo se nikam neukládá.

```bash
npm run dev
```

## 3. GitHub Pages

1. Vytvoř repozitář a nahraj projekt na větev `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Settings → Secrets and variables → Actions → Variables** přidej:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_AUTH_EMAIL`
4. Push na `main` spustí `.github/workflows/deploy.yml` a nasadí `dist/`.

Build používá `base: "./"`, takže funguje na `uzivatel.github.io/repo/`
i na vlastní doméně.

## Poznámka k heslu

Jedno heslo zadané v prohlížeči by na veřejném webu nestačilo — kdokoli by
si ho přečetl v bundlu. Proto jde ověření přes Supabase Auth a data chrání
RLS. Uživatelsky to ale zůstává „jedno heslo“.
