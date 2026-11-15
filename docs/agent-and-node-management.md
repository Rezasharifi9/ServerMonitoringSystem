# Agent and node management

## V2bX geodata preparation

Before a fresh V2bX installation or managed reinstall changes configuration or
stops an existing service, the Agent prepares `geoip.dat` and `geosite.dat` in
each Xray core's `AssetPath` (default `/etc/V2bX`). Missing datasets come from the
pinned XTLS/Xray-rules-dat release `20261113232526`; exact sizes and SHA-256
digests are checked before installation. Route categories are also checked.
Existing valid datasets are preserved. Invalid or incompatible existing datasets,
download failures and checksum failures stop preflight without applying the
V2bX configuration. The Agent does not periodically refresh these datasets.

Server inventory displays localized country names and flags from `countryCode`.
Unknown codes display an unknown-country label.

## Multiple tunnels

Nodes have a `tunnelIds` collection in addition to the selected
`primaryTunnelId` and `backupTunnelId`. Existing snapshots acquire the collection
when read, preserving both selected routes and existing tunnel associations. The
next workspace write persists it. New registrations have an optional UUID
`routeKey` so several tunnels with the same technology and endpoints can be
registered without ID collisions; retry the same key to replay a registration.

Registering an additional tunnel does not change the selected pair. Select the
pair and active side in **Node details → Tunnel**. A newly activated route must
have fresh healthy telemetry. `PUT /api/v1/nodes/:id/routes` validates membership,
roles, the foreign host and distinct Iran hosts for the selected pair. Host
operation locks prevent competing provisioning and failover. Activation updates
DNS through the same provider path as failover before committing the selection;
DNS errors leave the selection unchanged. Automatic failover continues to use
the two selected routes. Removing a selected primary that has other primary
routes requires selecting its replacement first.

## Agent installation and bulk updates

The bundled Agent is version **0.4.0**. The installer accepts Python 3.8+ and
systemd 245+, including Ubuntu 20.04. Modern systemd uses DynamicUser and
LoadCredential. On systemd 245–246, telemetry and iperf use a dedicated
`nodeguard-agent` account and a private read-only token copy under
`/var/lib/nodeguard-credentials`; the original root token stays private.

SSH installation prepares missing Python and CA certificates. Root, passwordless
sudo and password-authenticated sudo are supported. Errors identify privilege,
prerequisite, upload, installation, enrollment or service-start failures. Only
transient connection-handshake failures are automatically retried. Successful
service installation is reported separately from receipt of telemetry.

**Settings → General → Update NodeGuard Agent** installs the version bundled
with the running panel on enrolled servers. It preserves host configuration and
credentials. The control plane needs its existing SSH installation setting and
a public HTTPS origin; each host needs a saved SSH connection.

`GET /api/v1/settings/agent-updates` returns the bundled version and latest batch.
`POST` with `{ "retry": false }` queues all enrolled hosts; `{ "retry": true }`
queues only failed hosts from the latest batch. Jobs are persisted in SQLite,
with at most three running concurrently. An unavailable host does not stop the
batch. Interrupted claims become eligible again after their lease expires
(11 minutes), after the per-host installation lock has expired. Settings polling,
the health worker and incoming telemetry resume pending work after a restart.
The API requires settings and Agent installation permissions and same-origin
protection for updates.

## Removing a V2bX node configuration

The server detail dialog lists only panel nodes linked through local inventory
or a successful recorded installation on that foreign host. The removal API
also checks that association. It does not delete the V2Board node.

Removing one node preserves other entries and the core binary. The worker checks
service startup and restores configuration if restart fails. Removing the last
node writes an empty node list, stops and disables the service, and preserves
the executable and systemd unit for later use.

## Verification

- `npm run test:management`: source integration tests for country localization,
  legacy migration, repeated same-role tunnel registration, route validation,
  DNS failure, batch concurrency, partial failure, retries and interrupted claims.
  SSH execution and DNS provider writes are simulated in this suite.
- `python -m unittest discover -s tests -p '*_test.py'`: installer, credential,
  probe and provisioning tests, including last-node core preservation and shared
  configuration rollback. Ubuntu/systemd version checks use mocked runtimes;
  Python sources are also parsed using the Python 3.8 grammar.
- `npm run test:backend`, `npm run test:i18n`, `npx tsc --noEmit` and
  `npm run build` cover the existing API and application behavior.

The compatibility tests are not full installations on every Ubuntu release.
Fresh VM installation tests for 20.04, 22.04, 24.04 and 26.04 remain an environment
validation step before claiming that complete release matrix has been exercised.
# جایگزینی سرویس‌های قبلی هنگام نصب

پس از Rebuild سیستم‌عامل، از جزئیات سرور ابتدا Agent را با SSH نصب کنید؛ نصب SSH همیشه کد ثبت تازه می‌فرستد و به وجود توکن قدیمی روی میزبان وابسته نیست. اعتبارنامهٔ قبلی فقط هنگام ثبت موفق جایگزین می‌شود. کارهای قدیمی در وضعیت review مانع تعمیر Agent نمی‌شوند؛ کارهای نصب زنده همچنان محافظت می‌شوند. اگر کلید SSH سرور عوض شده است، اتصال ذخیره‌شده را با اثرانگشت تازه بررسی و ذخیره کنید.

برای V2bX، اگر journal نصب قبلی حذف شده و هیچ سرویس V2bX بارگذاری‌شده‌ای وجود ندارد، Reinstall بستهٔ تأییدشدهٔ ذخیره‌شده در پنل را دریافت و با کنترل‌ها و بازگردانی نصب اولیه اجرا می‌کند. وجود سرویس بدون journal همچنان نیازمند بررسی است. اگر فایل‌های بسته در خود پنل هم حذف شده‌اند، از مسیر نصب V2bX بستهٔ تازه بسازید. قطع heartbeat به‌تنهایی اثبات Rebuild نیست و باعث حذف خودکار سوابق یا تنظیمات نمی‌شود.

Provision worker پیش از اعمال بسته، مالک پورت‌های Listen محلی تونل را با `ss` و cgroup شناسایی می‌کند. سرویس‌های systemd متداخل متوقف و غیرفعال می‌شوند تا سرویس مدیریت‌شده راه‌اندازی شود. پورت مقصد خارجی جزو پورت‌های قابل آزادسازی نیست. این رفتار برای listenerهای TCP/UDP تعریف‌شده در بسته‌های GOST، Backhaul، Rathole و پیکربندی‌های link/forward/WireGuard اعمال می‌شود.

نصب V2bX دیگر به نصب قبلی attach نمی‌شود؛ سرویس‌های متعارف نصب دستی (`V2bX.service` و `v2bx.service`) متوقف و غیرفعال می‌شوند و بستهٔ جدید نصب می‌شود. فایل‌های نصب قبلی برای بازیابی نگه داشته می‌شوند. وضعیت فعال و enabled سرویس‌های جایگزین‌شده در journal ثبت می‌شود و در شکست نصب یا rollback بازگردانده می‌شود. توقف ناگهانی Agent در میانهٔ عملیات همچنان نیازمند بررسی journal است.

SSH و سرویس‌های اصلی Agent قابل جایگزینی نیستند. مالک ناشناخته، پردازش خارج از systemd، listener کرنلی بدون PID و پورت‌هایی که از API پنل به‌صورت پویا تعیین می‌شوند تحت جایگزینی عمومی پورت نیستند؛ خطای راه‌اندازی باعث بازگردانی می‌شود. سرویس‌های دارای socket activation یا مدیر خارجی ممکن است مجدداً پورت را اشغال کنند. Agent سرورها باید با نسخهٔ جدید worker به‌روزرسانی شود.


## انتخاب روش انتقال GRE

در فرم ایجاد تونل GRE و بالای جزئیات تونل، «GRE معمولی (پروتکل IP 47)» یا «GRE روی UDP» را انتخاب کنید. حالت تونل‌های قبلی به‌صورت پیش‌فرض UDP می‌ماند. تغییر انتخاب فقط تنظیمات استقرار بعدی را ذخیره می‌کند؛ برای تونل فعال از بازسازی استفاده کنید. روش انتخاب‌شده در recipe هر دو سمت، شناسهٔ بسته و خلاصهٔ پیش‌نمایش منعکس می‌شود.

GRE معمولی به عبور پروتکل IP شمارهٔ ۴۷ در مسیر نیاز دارد و پورت UDP رزرو نمی‌کند. در این حالت بین هر جفت سرور فقط یک تونل GRE معمولی ثبت کنید. هنگام اجرای نصب، بازگردانی یا عملیات بررسی‌نشده، تغییر روش انتقال پذیرفته نمی‌شود.

## بازیابی تحویل دستور در Agent 0.5.3

Worker پیش از درخواست کار، شناسهٔ تصادفی درخواست را در `/var/lib/nodeguard/provision/pending-claim.json` با دسترسی 0600 و نوشتن اتمی ذخیره می‌کند. اگر پاسخ گم شود یا Worker مجدداً راه‌اندازی شود، همان شناسه به پنل ارسال و همان کار با همان مجوز برگردانده می‌شود. بعد از ثبت و تحویل نتیجه، شناسه پاک می‌شود. پنل فقط هش مجوز را نگه می‌دارد و درخواست تکراری، مهلت مجوز را تمدید نمی‌کند. مهلت درخواست‌های Provision از ۳ به ۳۰ ثانیه افزایش یافته؛ مهلت Worker اندازه‌گیری iperf تغییر نکرده است.

ابتدا پنل را ارتقا دهید و سپس Agent را نصب مجدد/به‌روزرسانی کنید. پنل با Agentهای قبلی سازگار است؛ بازیابی پاسخ گم‌شده به Agent جدید نیاز دارد. اگر Worker پس از شروع تغییر میزبان متوقف شده باشد، نتیجهٔ وقفه ثبت می‌شود و عملیات بدون بررسی دوباره اجرا نمی‌شود. مجوزهای منقضی و کارهای پایان‌یافته دوباره اجرا نمی‌شوند.
