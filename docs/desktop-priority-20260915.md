# Desktop-first follow-up

User deferred phone-specific work; phone is another client of the same underlying device controls. Existing phone firmware was left unchanged in this turn.

Desktop bus diagnostics now defaults to quick two-board discovery using known board addresses plus existing 1/184 defaults. Stops after finding one remote. Full 1–254 discovery remains an explicit button. Physical USB entries only are offered as gateways. Port changes, session changes and dialog closure invalidate stale scan results. ID display is provided; assignment/editing is not implemented by this change.

Checks: tests/chain_panel_test.mjs (mock DOM/API) passed quick scan, read-only calls, physical-only entries and cancellation; USB transport regression passed. Actual bidirectional DATA read-only verification passed with both USB cables connected, logs evidence/chain-readonly-1789462502.json. Served panel JavaScript matched disk exactly. No motor commands, backend restart, firmware flash or network changes. Tool-center registration updated without duplicate entry.

Still pending: configurable ID assignment and persistent topology discovery, full advanced control parity over single USB, and quantitative control-performance acceptance. Do not label this incremental UI change as completion of those items.
