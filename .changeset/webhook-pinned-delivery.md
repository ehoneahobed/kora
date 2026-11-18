---
'@korajs/auth': patch
---

Webhook delivery now connects to the address it checked, so DNS rebinding can no longer redirect a delivery to an internal address. Each attempt resolves the endpoint's host once, refuses it if any answer is private, and sends the request to that exact address with Node's `https`. The certificate is still checked against the host name. Before, `fetch` resolved the host a second time.

Two more address ranges are now refused as private:

- `::/96`, IPv4-compatible addresses;
- `64:ff9b::/96`, NAT64 addresses carrying a private IPv4 address.

A new `transport` option sends to a given address on runtimes without `node:https`. A custom `fetch` still resolves on its own and isn't pinned.
