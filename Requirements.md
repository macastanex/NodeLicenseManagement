# OOTB Dashboard / Web App Requirements Template

**Purpose:** Capture the business problem, intended use, scope, success criteria, ownership, and stakeholder alignment needed to approve an Out-of-the-Box (OOTB) SystemLink dashboard or web application before development, enhancement, or reuse begins.

**Document intent:** This is a reviewed requirements artifact. It is not intended to be a project tracker or continuously updated status document.

**Scope of this document:** This document captures the business and functional **WHY / WHAT** for an OOTB dashboard or web application. It focuses on the business problem, intended users, scope, information needs, success criteria, ownership, and stakeholder alignment. Technical implementation details belong in the HLD and developer guidance.

**What belongs elsewhere:** Technical design, UI layout, filtering, drilldown, deployment, security implementation, data mappings, detailed testing approach, and coding standards belong in the HLD, developer guide, or review checklist.

[[_TOC_]]

---

## 1. Asset Summary

| Field | Value |
|---|---|
| Asset Name | Node License Management |
| Asset Type | Web App |
| Approach | Build New |
| Existing Asset or Example, if applicable | Ports the logic of the internal `NodeLicenseCount.ipynb` analysis notebook |
| Epic | https://dev.azure.com/ni/DevCentral/_workitems/edit/3839516 |
| Business Owner | Moyer |
| Technical Owner | Michael Castaneda |
| Reviewer(s) | _TBD_ |
| Stakeholder(s) | Josh, Moyer, R&D Product Owner |

**Summary**

Node License Management is a read-only Angular web app (built with NI Nimble components) that runs embedded inside SystemLink and reports how a deployment is consuming its node licenses. It queries SystemLink Systems Management and Test Monitor with same-origin API calls and presents a consolidated view of every node it can observe, classified as **Managed (licensed)**, **Unmanaged**, **Inactive/Stale**, or **Virtual**. Alongside the current counts it renders a 12-month trend and a per-node detail table with a direct link to each node's latest test result. It exists as an OOTB asset so administrators and account teams can understand license consumption, spot nodes running tests outside of management, and identify stale licenses — from a single page instead of reconstructing the picture by hand from raw systems and results data.

**Intended-use statement:**

_This asset is intended for SystemLink administrators, account teams, and support engineers who need to understand node license consumption at a glance and identify which nodes are managed, unmanaged, stale, or virtual so they can reconcile licensing and manage their fleet._

---

## 2. Business Problem

1. **What business problem is being addressed?**
   There is no simple, consolidated way to understand how many nodes a SystemLink deployment is licensing, how that number is trending, and which specific machines make up that count. Reconciling license consumption today requires manually combining Systems Management data with Test Monitor results.

2. **Who experiences this problem?**
   SystemLink administrators, NI account/field teams, and anyone responsible for reconciling node licensing against what is actually deployed and testing in an environment.

3. **How is the work performed today?**
   Node counts are derived ad hoc — by exporting systems lists, cross-referencing test results, and hand-writing scripts or notebooks (e.g. `NodeLicenseCount.ipynb`) to de-duplicate hosts and separate managed from unmanaged machines. The classification rules live in individuals' heads or one-off code.

4. **What is inefficient, manual, inconsistent, unclear, or difficult today?**
   Determining "how many nodes am I licensing and which are they?" requires specialized queries and careful de-duplication (host-name casing, null/empty hosts, hosts misreported under a system ID, virtual systems, RT targets that report `localhost`). Done by hand it is slow, error-prone, and inconsistent between people, so the same environment can produce different numbers.

5. **What information, visibility, or workflow is missing?**
   A single, repeatable view that classifies every observable node as Managed, Unmanaged, Inactive, or Virtual using one agreed-upon definition; shows the current counts, a 12-month trend, and per-node detail; and lets a user jump from a node to its latest test result for verification.

6. **Why is this worth addressing as an OOTB dashboard or web app?**
   Understanding node license consumption is a universal need across every SystemLink deployment. A reusable, definition-driven OOTB web app removes the need for per-engagement notebooks or scripts and gives every customer and field team the same consistent, auditable node count.

---

## 3. Intended Users and Use

1. **Who is the intended audience for this asset?**
   SystemLink administrators, NI account/field teams, and support engineers operating or reconciling licensing for a SystemLink environment.

2. **What job, workflow, or decision does this asset support?**
   It supports license reconciliation and fleet review: confirming how many nodes are being licensed, watching that number trend over 12 months, distinguishing managed from unmanaged machines, and finding stale licenses that may be reclaimable.

3. **What specific information or capability does the application provide to the user to complete the workflow?**
   Aggregate counts for Managed, Unmanaged, Inactive, and Virtual nodes; a 12-month stacked trend of managed vs. unmanaged; and a per-node detail table (minion/host, node type, status, registered date, last active, and a link to the latest test result). Summary cards act as filters, and search isolates a specific node. The precise definition and calculation of each node type is the core of this asset and is described below.

### 3a. Node Definitions and Calculation Logic

This is the heart of the asset. Every count is derived from two SystemLink sources — **Systems Management** (`/nisysmgmt/v1/query-systems`) for the managed fleet and **Test Monitor** (`/nitestmonitor/v2/query-result-values`) for hosts that have submitted test results — and reconciled into four mutually meaningful categories. Counts are taken as a **monthly snapshot** (the first of the month, UTC), and the license/activity window is **12 months** (`LICENSE_DURATION`). The current snapshot plus the prior 11 build the 12-month trend.

**Managed (Licensed) nodes**
- **Definition:** A real system registered in SystemLink that consumes a node license as of the snapshot.
- **Source & filter:** `query-systems` where the system has a non-empty host (`grains.data.host != null and grains.data.host != ""`), is activated (`activation.data.activated == true` or `null`), and — on editions that support it — is **not** virtual (`connected.data.state != "VIRTUAL"`).
- **Snapshot rule:** Only systems whose `createdTimestamp` is on or before the snapshot are counted for that month, so the trend reflects when each node was registered.
- **Display host:** The friendly SystemLink Hostname (`grains.data.localhost`) is preferred; NI Linux RT targets report `grains.data.host` as the generic `localhost`, so the raw host is only used as a fallback and is retained internally for result matching.

**Inactive / Stale nodes**
- **Definition:** A **subset of Managed** nodes that appear dormant — licensed but not checked in within the license window.
- **Rule:** `lastUpdated` (`connected.lastUpdatedTimestamp`) is on or before `snapshot − 12 months` **AND** the node is not currently connected (`connectionState !== "CONNECTED"`).
- **Note:** Connection state is only known on editions that expose `connected.data.state`; where it is unavailable the rule reduces to the timestamp test alone. Inactive nodes are still Managed (they still consume a license) — the status simply flags them as reclaim candidates.

**Virtual nodes**
- **Definition:** Systems reported by SystemLink as virtual (`connected.data.state == "VIRTUAL"`).
- **Rule:** Retrieved by a separate `query-systems` call and tracked distinctly from the physical managed count. They are surfaced with a Virtual status in the detail table.
- **Edition note:** Virtual nodes are an Enterprise-edition concept. On editions with no virtual-node support the virtual query is skipped entirely and the virtual count is 0.

**Unmanaged nodes**
- **Definition:** A host that has submitted test results but is **not** part of the managed fleet — i.e., a machine testing against SystemLink without being licensed/managed.
- **Source:** Distinct `HOST_NAME` values from Test Monitor results within the snapshot's 12-month window, **minus** any host that matches a managed node (compared case-insensitively, including a managed node's raw `localhost` host) or a virtual node.
- **Misclassified hosts (reported under `SYSTEM_ID`):** Some results carry the machine under `SYSTEM_ID` with a null/empty host name. Each distinct `SYSTEM_ID` that is **orphaned** — not a real system in the fleet, not already a managed/virtual/known-host node, and never seen with a populated host name — is counted as one unmanaged node. A `SYSTEM_ID` that resolves to a real minion, or that also appears with a host name, is **not** double-counted.
- **Null / empty host collapse:** Results that have neither a host name nor a system ID collapse into a single representative "(no host name)" node and a single "(empty host name)" node, rather than inflating the count with anonymous rows.

**De-duplication and precedence (applied across all categories)**
- Host names are compared case-insensitively (upper-cased) so `Alpha-01` and `alpha-01` are one node.
- Precedence when the same machine could appear more than once: **Managed** wins over Unmanaged; a host-name identity wins over a `SYSTEM_ID`-only identity; a real system wins over an orphaned system ID. This guarantees each physical node is counted exactly once.

4. **Aggregate indicators derived from the above**
   - **Managed**, **Unmanaged**, **Inactive**, and **Virtual** current counts (summary cards).
   - **12-month trend** of managed vs. unmanaged counts, one point per month.
   - **Per-node detail**: display host/minion, node type, status (Active / Inactive / Virtual), registered date, last active timestamp, and a link to the node's latest test result.

---

## 4. Scope

### In Scope

1. Which SystemLink editions and versions must be supported?
Valinor (SL Base, Full, Pro), SLE, and SystemLink Server (SLS).

2. Does this app require any configuration?
No runtime configuration is required; the app auto-detects edition capabilities (e.g. virtual-node support) and adapts its queries.

3. How will this application be configured? At runtime/build?
Deployment-time only (published as a hosted web app). No end-user configuration surface.

4. Provide a list of in-scope functionality:
- Read-only, same-origin classification of every observable node into Managed, Unmanaged, Inactive, and Virtual using the definitions in Section 3a.
- Current summary counts for each node type, plus overall totals.
- A 12-month stacked trend of managed vs. unmanaged nodes.
- A per-node detail table (display host/minion, node type, status, registered date, last active, latest-result link).
- Search across nodes and status filtering driven by the summary cards.
- On-demand manual refresh; progressive rendering (counts first, per-node "last active"/result enrichment second).
- Direct link from a node to its latest Test Monitor result for verification.
- Automatic edition compatibility: virtual-node detection, `connected.data.state` fallback, and RT `localhost` hostname resolution.
- Nimble theme-aware UI (light/dark) matching the host SystemLink shell.
- Reads app configuration/version from the host (`/api/config`).

### Out of Scope

- Writing, modifying, or deleting any SystemLink data or configuration (the app is strictly read-only).
- Enforcing, allocating, or reclaiming licenses; the app reports consumption, it does not change entitlements.
- Continuous/automated background monitoring, alerting, notifications, or paging.
- Persisting or storing node counts over time beyond the on-the-fly 12-month trend (no historical database).
- Per-node inventory beyond what Systems Management and Test Monitor expose (no deep hardware/software inventory).
- Root-cause analysis or automated remediation of stale/unmanaged nodes.
- Authentication/identity management (the app relies on the host session and same-origin routing).
- Cross-origin or multi-deployment aggregation from a single instance.
- A UI to change the node-classification rules at runtime.

## 5. Alignment and Ownership

1. **Does an equivalent solution already exist?**
   No OOTB equivalent; node counts are currently derived manually or with the internal `NodeLicenseCount.ipynb` notebook, whose logic this app formalizes. Teams should align on this single solution and retire ad hoc notebooks/scripts.

2. **Is there an existing dashboard, web app, prototype, customer-specific asset, or R&D implementation that should be reused, enhanced, or incorporated?**
   The `NodeLicenseCount.ipynb` analysis notebook is the direct source of the classification logic and has been ported and consolidated into this app.

3. **Does this asset overlap with another roadmap item, customer deliverable, or internal initiative?**
   _TBD._ Potential overlap with licensing/entitlement reporting roadmap work should be reviewed.

4. **If an R&D solution planned, is it in progress, or when will it be available? Provide the AzDO ticket.**
   _TBD._ To be confirmed.

5. **Who owns the asset after release or publication?**
   _TBD._

6. **Who should review the asset before development proceeds?**
   _TBD_ — recommended reviewers include SystemLink platform/architecture, licensing, and field/support representatives.

7. **Is this intended as a permanent solution for a product-gap?**
   _TBD._ It currently fills the gap of there being no OOTB node-license consumption view.

8. **Will this app be sold?**
   No.

9. **Are there known dependencies, risks, or open questions that could affect whether this should proceed?**
   - The count is only as complete as what Systems Management and Test Monitor expose; a node that neither is managed nor has ever submitted a result cannot be observed.
   - Classification depends on how results were submitted (host name vs. system ID vs. null host); the reconciliation rules in Section 3a mitigate but cannot fully repair inconsistent source data.
   - Edition differences (virtual nodes, `connected.data.state`, RT `localhost` hosts) require the compatibility handling described above; new edition behaviors may need review.
   - Counts are month-snapshot based; a node registered mid-month is reflected at the next snapshot, which must be understood when comparing against other tools.

## 5. Security and Permissions

The app is read-only and issues same-origin requests using the signed-in user's existing SystemLink session; it does not manage or store credentials. It reads only the services required to enumerate systems and their test results.

| Service | Read/Write |
|---|---|
| Systems Management (`/nisysmgmt`) | Read |
| Test Monitor (`/nitestmonitor`) | Read |
| Web App Host config (`/api/config`) | Read |

## 6. Success Criteria
_Define what business success means if this asset is delivered. These should describe outcomes, not implementation details._

- Users can determine, at a glance, how many nodes a deployment is licensing and how that number breaks down into Managed, Unmanaged, Inactive, and Virtual.
- The node count is produced from one agreed-upon, auditable definition, so the same environment yields the same numbers regardless of who is looking.
- Users can identify specific unmanaged nodes (machines testing without being managed) and stale nodes (licensed but dormant) and verify each against its latest test result.
- Users can see how node consumption has trended over the last 12 months without assembling the data by hand.
- The asset provides a reusable OOTB view that works across Valinor, SLE, and SLS without per-engagement scripting or notebooks.
- The asset reduces reliance on ad hoc notebooks, manual host de-duplication, and direct query work to answer "how many nodes are we licensing, and which ones?"

---

## Appendix A: Belongs Outside This Requirements Document
The following items should be captured in the HLD, developer guide, coding standards, review checklist, or release process instead of this requirements document:

- UI layout and page design
- Dashboard or web app navigation
- Filtering, sorting, drilldown, and export mechanics
- Visualization selection
- Technical architecture
- Data architecture and mappings (exact query filters, projections, pagination)
- API design or backend service changes
- Security implementation details
- Deployment and configuration
- CI/CD, repository, and package structure
- Unit, system, regression, and compatibility testing details
- Code review and static analysis requirements
- Operational runbooks and support procedures
