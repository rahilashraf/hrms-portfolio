# Web design system

The shared building blocks of the web app live in `apps/web/src/components/ui`. New and changed
screens use them; working screens are not rewritten just to adopt them ("adopt when you touch
it"). Everything here is generic: no organization- or industry-specific wording.

## Style tokens (`ui/tokens.ts`, `ui/button.ts`)

| Token                                              | Use                                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buttonClass(variant, size)`                       | `primary` (branded), `secondary`, `destructive` (a dialog's confirm), `danger` (outlined trigger of a destructive action), `ghost`; sizes `md`, `sm` |
| `primaryButton`, `secondaryButton`, `dangerButton` | The same, under the names modules already used                                                                                                       |
| `inputClass`                                       | Inputs, selects and textareas under their label; red border when `aria-invalid`                                                                      |
| `checkboxClass`                                    | A native checkbox at the WCAG 2.2 target size (24 × 24 px), in the brand accent with the brand focus ring                                            |
| `badgeClass(tone)`                                 | Status pills: `neutral`, `info`, `success`, `warning`, `danger` (all at least 4.5:1)                                                                 |

Module files that used to define their own versions of these (compensation, leave, Google
Workspace, attendance) re-export the tokens, so every module gets the same styles.

**Branding.** Organization branding sets `--hrms-accent`, `--hrms-on-accent` and
`--hrms-accent-text` (only when the brand color keeps 4.5:1, `lib/branding/color.ts`). Primary
buttons, tabs, the active sidebar indicator and icon, page header eyebrows, the skip link and the
global focus outline use them. Do not hard-code `indigo-*` for accents in new code.

**Text colors.** Meaningful text uses `slate-500` or darker on white (`slate-600` on
`slate-50`/`slate-100`); `slate-400` is for decorative icons only.

### Buttons

- **Buttons never fade in.** `buttonClass` transitions colours, the focus ring and hover
  brightness (`transition-[color,background-color,border-color,box-shadow,filter]`), never
  opacity. A disabled button (60% opacity) that becomes enabled is fully opaque at once; an
  opacity transition would leave it briefly below 4.5:1 while already usable, which axe reports as
  an intermittent `color-contrast` failure. Do not add `transition` or `transition-all` to a
  button that can be disabled.
- **Sign-in button.** `authSubmitButtonClass` follows `buttonClass`: no opacity transition;
  disabled with a wait cursor and "Please wait…" while submitting, opaque the moment it is
  enabled again.

### Inputs and checkboxes

- **Inputs show a focus ring.** `inputClass` (and scheduling's own input class) draws the
  accent-coloured 2 px ring on focus (with `outline-hidden`, so forced-colours mode keeps an
  outline), like buttons and checkboxes, instead of the browser default (which a date input does
  not draw on the control itself).
- **Every checkbox is 24 px.** All native checkboxes (except the kiosk's own 24 px box) use
  `checkboxClass` or a module alias of it; `ui/checkbox-usage.test.ts` fails on any other.
  `checkboxClass` uses `outline-hidden` too, so forced-colours mode keeps an outline.
- **Selects with long options.** Use `inputClass` (full width under its label) and a separate
  `<label htmlFor>` when the select sits in a flex row; give it `sm:w-auto sm:max-w-md` if it
  should not stretch on wider screens. Show names, never raw ids, in options.

## Focus

Focus rings use the organization's accent text color (`--hrms-accent-text`, kept at 4.5:1 or
more on white by branding): `focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]`
(buttons add `ring-offset-2`; destructive buttons use `rose-700`). Never hard-code
`ring-indigo-*`.

A component that draws its own ring opts out of the global outline with `outline-hidden`, never
`outline-none` (Windows forced-colours mode removes box-shadow rings; `outline-hidden` leaves a
transparent outline that the system paints). A visually hidden control (an `sr-only` radio in a
chip label, the kiosk PIN field) shows focus on its visible stand-in with `focus-within:` or
`peer-focus:` and the matching `outline-hidden`. `src/lib/a11y/focus-classes.test.ts` enforces
these rules, and `e2e/forced-colors-focus.spec.ts` checks focus in both modes.

## Page frame and layout (`ui/page-container.tsx`, `lib/navigation/page-width.ts`)

- **`PageContainer width="narrow" | "default" | "wide" | "full"`** is a page's outer frame
  (3xl / 5xl / 6xl / 7xl; `pageContainerClass(width)` for class-only cases). No page renders a raw
  `mx-auto max-w-* px-*` frame.
- **One frame per route, from the first paint.** `pageWidthFor(pathname)` is the table of every
  signed-in route's `PageContainer` width. The route skeleton
  (`app/(app)/(authenticated)/loading.tsx`) and the route error (`error.tsx` →
  `RouteErrorState width`) render in that width, so the page replaces them without a jump; so
  does the in-shell 404 (`not-found.tsx`). A page keeps choosing its own width; when it changes,
  change the table too. `page-width.test.ts` and `route-fallbacks.test.tsx` pin the table and the
  fallbacks' frames; the `ui-acceptance` suite compares the table with the rendered pages and
  records the skeleton's width whenever it shows (whether it shows depends on Next's prefetch
  cache).
- **Loading, denied and loaded share one width.** Render the same width while loading, while
  access is checked and once loaded. A page returns `Forbidden` inside
  `<PageContainer width={…} padded={false}>` (as `RequirePermission` does), never bare: the denied
  card stays centred, but the frame keeps the page's width.
- **Grids that hold wide content.** Responsive grids state their base column too —
  `grid grid-cols-1 sm:grid-cols-2`, not `grid sm:grid-cols-2`. `grid-cols-1` is
  `minmax(0, 1fr)`, so a wide table (inside its scroll region) or a long select option cannot
  widen the column, and with it the page, on a phone.

## Tables (`ui/data-table.tsx`, `TableScroll` in `ui/states.tsx`)

`DataTable<T>({ label, columns, rows, rowKey, loading, empty, stacked })` renders a table of
records:

- Always inside a named, keyboard-focusable `TableScroll` region; `scope="col"` headers; shared
  loading and empty states.
- The column that names the row (`rowHeader`) renders `th scope="row"`: screen readers announce
  it with each cell, and tests find it by the `rowheader` role. `rowLabel` optionally gives each
  row an accessible name where rows were already named (document versions: "Version 2");
  otherwise a row is named by its cells.
- Horizontal scroll is the default on phones; `stacked` adds label/value cards below `sm` only
  where they clearly help. `minWidth="min-w-[760px]"` keeps a wide table's columns from squeezing
  on phones (the named region scrolls instead); `bare` drops the region's frame for a table inside
  an already bordered panel.
- Presentation only: rows and row actions come from the API (its action flags).
- **Two tables, one name.** A table inside a section of the same name gets a more specific region
  name ("Applications of Ada Lovelace", "Workflow tasks"), so screen readers and tests never meet
  two regions with one name.
- **Financial tables.** Payroll tables use `DataTable` with the API's amounts exactly as formatted
  by `formatMoney`; presentation components never sum or recompute money. Money columns keep
  their alignment.

**Documented raw-table exceptions** (keyboard-scrollable, named `TableScroll` regions, not
`DataTable`):

- calendars: the schedule calendar and the leave calendar (grids of days);
- the attendance overview (employee × day matrix), timesheet daily time (`rowSpan`/`colSpan`
  grouping), the exception review and the notification delivery log and its attempts
  (expandable detail rows), the correction review (before/after comparison) and scheduled hours
  (totals row);
- the onboarding task table (`workflow-page.tsx`): each row is a stateful component with inline
  waive, reopen, reassign and due-date panels, with a local `cell` constant matching `DataTable`
  padding;
- the printable payslip (`payslip-document.tsx`), which keeps `Table`/`cell` from
  `payroll-shared`: a print layout, not an interactive data table.

## Statuses (`ui/status-badge.tsx`)

`StatusBadge status="PENDING"` (optional `label`, `tone`) shows a status pill. The words are
always shown; one central `STATUS_TONE` map (success / info / warning / danger / neutral;
unknown → neutral) sets the colour. New code uses it instead of a module-local badge.

Where the meaning is domain-specific, pass an explicit `tone` that keeps each state distinct:

- draft schedule = warning, cancelled shift = danger;
- validation severities: error = danger, warning = warning, info = neutral;
- an active onboarding workflow is "info" (in progress, not "success"); a waived task is
  "warning"; a cancelled opening is "danger";
- a cancelled goal and a superseded benefit election stay "danger"; a pending election is "info".

Some states keep their own badge components, because the shared five tones would merge distinct
consecutive steps: timesheet states (Locked = violet), expected attendance (Excused = violet),
payroll run states (Draft, Calculated, Approved, Finalized, Voided), recruitment application and
offer statuses (active → offered → hired; draft → approved → sent → accepted) and performance
review statuses (six steps). Confidentiality levels and notification categories are
classifications, not statuses, and keep their colours.

## Tabs and deep links (`ui/tabs.tsx`, `lib/navigation/use-tab-param.ts`)

Tabs are `TabList` + `TabPanel` (tab roles, arrow keys, Home/End, roving focus). A row of
buttons that swaps the page's content is a tab list, not a set of `aria-pressed` buttons. The
notification inbox's All/Unread/Archived switcher is a `TabList` without panels (a filter, not a
deep link).

`useTabParam(tabs, initial, { mode: 'hash' | 'query', param, writeHash })` keeps the selected tab
in the URL:

| Mode                          | Behaviour                                                                                                                                                                  | Used by                                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hash` (default)              | A hash naming a tab wins; picking another tab clears a hash that no longer matches. `useHashTab` is this mode.                                                             | The base for `writeHash`; no page currently uses it alone                                                                                                                                       |
| `hash` with `writeHash: true` | Picking a tab (by click or arrow key) writes `#tab`, so the address bar always names the visible section; the query is kept (`/admin/onboarding?onboardEmployee=…#start`). | Employee profile, `/admin/recruitment`, `/admin/onboarding`, `/admin/performance`, `/admin/benefits`, `/admin/notifications`, `/admin/documents`, My performance, `/admin/time`, `/admin/leave` |
| `query`                       | The parameter (`?tab=history`) is the source of truth, written on change (removed for `initial`); other parameters and the hash are kept.                                  | My Time (`/time?tab=history&date=…`), attendance administration (`/admin/time?attendanceTab=kiosks#attendance`), `/admin/payroll?tab=calendars`, `/admin/payroll/runs/:id?tab=validation`       |

In every mode the URL is replaced, not pushed (Back leaves the page instead of stepping through
tabs), Back/Forward re-read it, and a choice that becomes unavailable or a hash naming no
available section falls back to `initial`. Keep the mode a page already uses so existing links
keep working; never replace an existing query link with a hash link. Same-page links that change
only the query (the sidebar's attendance links) are picked up because the sidebar sends
`notifyLocationHashChange()`.

## Permissions and loading (`ui/require-permission.tsx`)

- **`RequirePermission anyOf={[...]} width=...`** (or `PermissionGate loading allowed`) shows
  "Checking your access…" in the page's width while permissions load, the shared denied state
  when they are missing, else the page. **Presentation only**: the API enforces every request;
  never use it as an authorization check.
- **Authorization loading.** `useAuth().authorizationLoading` is true from sign-in until the
  authorization snapshot has loaded (or failed), so permission checks never see an empty snapshot
  as "no permissions".
- **Pages that load a record first** (role details, user access): render loading while
  permissions _or_ the record load, then an API error as an error (`role="alert"`), then the
  denied state, then the page — never "Access denied" before permissions are known.
- **Pages that admit users without a permission.** Recruitment administration also opens for
  hiring managers whom the API lists for an organization, so it cannot use `RequirePermission`.
  It renders its loading and denied states in its own `PageContainer` width (`wide`) instead.

## Feedback states (`ui/states.tsx`, `ui/inline-message.tsx`, `ui/toast.tsx`)

| Situation                                                   | Component                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A page or panel loading                                     | `LoadingState` (skeleton) or `LoadingText` (one line); both `role="status"`                           |
| Nothing to show                                             | `EmptyState` with `title`, `description`, `action`; or text-only `<EmptyState>No items.</EmptyState>` |
| A page or panel failed to load                              | `ErrorState` (with retry)                                                                             |
| The result of submitting a form                             | `InlineMessage` (`success`, `error`, `info`, `warning`) next to the form                              |
| The result of a row/list action, or one that navigates away | A toast (`useToast`)                                                                                  |

`ErrorBanner` and `FeedbackMessage` (in `organization/shared.tsx`, used by many modules) render
`InlineMessage`. Existing inline success messages are not migrated in bulk.

## Confirmations (`ui/confirm-dialog.tsx`, `ui/use-confirm.tsx`, `ui/confirm-button.tsx`)

Every action with a lasting effect that one click would otherwise perform — finalize, close,
archive, retire, disable, delete, revoke, void, issue a new credential — goes through the shared
dialog. Never use `window.confirm` or a local `<dialog>`.

- `ConfirmButton` for a single button: `<ConfirmButton confirm={{ title, description,
confirmLabel }} onConfirm={() => archive()}>Archive</ConfirmButton>`.
- `useConfirm()` when the confirmation sits inside a handler: `if (await confirm({...})) …`.
- A reason for the audit trail: `confirm.reason` on `ConfirmButton`, or `useConfirmWithReason()`
  (`{ label, required, maxLength, defaultValue, hint }`); a required reason keeps the confirm
  button disabled. Use the API's length limit.

Wording: the title names the action and the record ("Archive Safety quiz?"); the description says
what changes and what is kept; the confirm button repeats the verb ("Archive stage", never "OK").
Reversible, low-impact actions (enabling something, resetting a setting) are not confirmed.

The dialog is an `alertdialog`: labelled, focus on Cancel, Tab trapped, Escape and the backdrop
cancel, focus back on the trigger.

## Forms (`ui/form/form-field.tsx`, `lib/forms/`)

New and substantially changed forms use **React Hook Form with Zod**:

```tsx
const form = useForm<Values, unknown, Parsed>({ resolver: zodResolver(schema), defaultValues });
<InputField label="Code" required hint="2–64 letters" error={errors.code?.message}
  registration={form.register('code')} />
<SubmitButton busy={form.formState.isSubmitting}>Create role</SubmitButton>
```

- **Fields:** `InputField`, `SelectField`, `TextareaField` and `CheckboxField` take a
  `register()` result; `FormField` wraps any other control (render function receiving `id`,
  `aria-invalid`, `aria-describedby`, `aria-required`). Labels are always visible (`hideLabel`
  only in table rows); hints stay under the field; errors are announced. React Hook Form
  focuses the first invalid field on submit.
- **`ControlField`** is `FormField` for one native control passed as its child: label tied by
  `htmlFor`/`id`, hint by `aria-describedby`, the control's own value and handlers untouched.
  Existing `useState` forms use it instead of a local label wrapper (Benefits and Performance
  re-export it as `Field`); new forms still use React Hook Form.
- **Schemas:** mirror the API DTO limits. `lib/forms/schemas.ts` has `requiredText`,
  `optionalText`, `dateString` (real calendar days only), `optionalDateString` and `recordId`.
- **API errors:** `applyApiErrors(cause, setError, { fields, codes })` puts class-validator 400
  messages on the field their property names and coded refusals where mapped; show what it
  returns in `outcome.message` (or the module's error text) as the form-level `InlineMessage`.
- **Submitting:** `SubmitButton` is disabled and says what it is doing while busy.
- **Long forms:** `useUnsavedChangesWarning(isDirty)` asks before leaving the page.
- Existing `useState` forms are not rewritten just to adopt this; convert a form when it is
  substantially changed.

## Record pickers (`ui/record-combobox.tsx`, `lib/pickers/`)

Never ask users to type a record's ID when the API offers a search.

- **`RecordCombobox`** — the default: a WAI-ARIA combobox over a server search (type, Arrow
  keys, Enter, Escape, Tab; "Load more results"; announced results, loading and errors;
  clearable). The value is the record id.
- **`SearchPickList`** — the same search over a visible list, for pickers that stay open.
- **`AssignmentIdPicker`** — employee, then one of their assignments.
- **Sources** (`lib/pickers/sources.ts`): `employeeSource`, `positionSource`,
  `managerAssignmentSource`, `personSource`, `userSource` (`activeOnly` for actions that need
  an active account), `candidateSource`, `structureSource` (units, departments, teams,
  positions), `payGroupSource`, `listSource` for any short list. Create them with `useMemo`.
- **Permissions:** a picker shows only what its search endpoint returns for the user; it is a
  convenience, not a security boundary — the action's endpoint still checks everything sent.
  When the screen's users may not hold the search's permission, pass `manualEntry` so they can
  type the ID instead (it opens by itself when the search answers 403).
- **Behavior built in** (`useRecordSearch`): debounce, cursor paging, only the latest answer
  counts, "loading" until the current query is answered.

## App shell

The notification bell is in the header below `lg` and in the sidebar from `lg`; CSS shows
exactly one, and every bell shares one unread-count request (`useUnreadNotificationCount`). The
mobile navigation makes the page behind it inert.

## Touch targets and the kiosk

- **Small targets in dense grids.** Interactive elements inside calendars and other dense grids
  are at least 24 × 24 px (`min-h-6`) with the brand focus ring.
- **Kiosk (dark, shared device).** Buttons are at least 48 px tall (`min-h-12`), keypad keys at
  least 44 × 44 px, and every control has a high-contrast `focus-visible:ring-4 ring-sky-300`
  with a slate-900 offset (the brand ring does not show on the kiosk's dark surface). Kiosk flows,
  PIN handling and timeouts are not design-system concerns and must not change with styling.

## Tab title (`ui/use-document-title.ts`)

Set the browser tab title with `useDocumentTitle(title)`, never `document.title =` in an effect:
Next.js commits the layout's metadata title after hydration and would overwrite it.

## Accessibility checks and tests

- Shared components have unit tests next to them. Component tests call
  `expectNoAxeViolations(container)` (`src/test/axe.ts`, vitest-axe; contrast is checked in the
  browser).
- Playwright flows end with `expectNoSeriousA11yViolations(page)` (`e2e/support/axe.ts`,
  @axe-core/playwright, WCAG 2.1 A/AA, serious and critical fail).
- **Acceptance suite.** `e2e/ui-acceptance.spec.ts` checks 23 major routes at 1440, 1280, 820
  and 375 px (plus 320 px): no page-wide horizontal scroll, no action pushed off-screen,
  scrollers are named focusable regions (or hold focusable controls), one `h1` and no skipped
  heading level, axe (serious/critical), the page's own width from the first paint (skeleton,
  access check, loading, loaded) and a visible focus indicator on the first controls in main.
  `e2e/ui-acceptance-flows.spec.ts` covers deep links (hash and query, replace-not-push, reload,
  unknown tab, Back/Forward), loading vs denied (no data, no module request), raw error text,
  the kiosk (tablet portrait/landscape, phone, 44 px targets, keyboard PIN, alerts, idle reset,
  completion) and the sign-in button. Add a route to `e2e/support/acceptance-routes.ts` when a
  major page is added.
- The Playwright suite mocks the API and runs against a production build of the web app, in
  Chromium only. See [`docs/testing.md`](../testing.md).
