# استقرار کنترل‌پلین NodeGuard با systemd

این راهنما برای یک میزبان Linux با systemd 247 یا جدیدتر، Node.js 24 در `/usr/bin/node` و یک دیسک محلی ماندگار است. سرویس Next.js روی `127.0.0.1:3000` گوش می‌دهد و از طریق reverse proxy با HTTPS به مرورگر و Agentها سرویس می‌دهد. Workerهای مرکزی از همان loopback استفاده می‌کنند. [راهنمای میزبانی Next.js](https://nextjs.org/docs/app/guides/self-hosting)

## آماده‌سازی

نسخهٔ پروژه را با دسترسی خواندن برای حساب‌های سرویس در `/opt/nodeguard` قرار دهید. در همین مسیر، وابستگی‌ها را با `npm ci` نصب و با `npm run build` ساخت تولید را آماده کنید. فایل محلی `.env.local` توسعه را کنار نسخهٔ تولید قرار ندهید. اگر Node یا پروژه در مسیر دیگری قرار دارد، پیش از نصب واحدها `ExecStart` و `WorkingDirectory` را با مسیر واقعی هماهنگ کنید.

از ریشهٔ پروژه این فرمان‌ها را اجرا کنید. روی میزبان تازه، فرمان اول حساب اختصاصی سرویس را ایجاد می‌کند.

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin nodeguard-control
sudo install -d -o root -g nodeguard-control -m 0750 /etc/nodeguard/control-plane
sudo install -d -o root -g root -m 0700 /etc/nodeguard/control-plane/workers
sudo install -m 0644 deploy/systemd/nodeguard.control.service deploy/systemd/nodeguard.worker@.service /etc/systemd/system/
```

در نصب اول، نمونه را به‌عنوان فایل خصوصی تنظیمات کپی و ویرایش کنید.

```sh
sudo install -o root -g root -m 0600 deploy/systemd/control.env.example /etc/nodeguard/control-plane/control.env
sudoedit /etc/nodeguard/control-plane/control.env
```

برای اتصال ادمین V2Board از پنل، `NODEGUARD_CREDENTIAL_KEY` را با یک کلید ۶۴ رقمی hex تصادفی و مستقل در `control.env` تنظیم کنید. کلید با دادهٔ SQLite همین محیط نگهداری می‌شود و برای خواندن نشست رمزنگاری‌شده پس از بازراه‌اندازی لازم است.

برای ورود عملیاتی، `NODEGUARD_ADMIN_USER` و `NODEGUARD_ADMIN_PASSWORD_HASH` را در `control.env` تنظیم کنید. قالب هش `scrypt:<salt-hex>:<digest-hex>` است؛ نمک تصادفی ۱۶ بایتی و خروجی scrypt برابر ۳۲ بایت است. ورود در `/login` با نام کاربری و رمز انجام می‌شود. با فعال شدن حساب ادمین، ورود توکنی کاربر غیرفعال است. برای محیط آزمایشی بدون حساب ادمین، `NODEGUARD_USER_TOKENS` را با توکن تصادفی جدا برای هر حساب فعال تنظیم کنید. مقدار را می‌توانید با `node -p "require('node:crypto').randomBytes(32).toString('hex')"` تولید کنید. برای دسترسی از HTTPS، `NODEGUARD_ORIGIN` را روی مبدأ عمومی و `NODEGUARD_SECURE_COOKIE=1` تنظیم کنید.

نمونه در حالت `simulation` شروع می‌شود. برای پایش، `NODEGUARD_WORKSPACE_MODE=monitor`، `NODEGUARD_DB_PATH=/var/lib/nodeguard-control/monitor.sqlite` و مسیر مطلق `NODEGUARD_INVENTORY_PATH` را تنظیم کنید. فایل موجودی را با دسترسی `0640` و مالکیت `root:nodeguard-control` در مسیر تنظیم‌شده قرار دهید. systemd پوشهٔ داده را برای حساب سرویس می‌سازد و SQLite وضعیت را در همان پوشه نگه می‌دارد. [تنظیمات اجرای systemd](https://manpages.ubuntu.com/manpages/noble/man5/systemd.exec.5.html)

## راه‌اندازی و بررسی

```sh
sudo systemd-analyze verify /etc/systemd/system/nodeguard.control.service
sudo systemctl daemon-reload
sudo systemctl enable --now nodeguard.control.service
systemctl is-active nodeguard.control.service
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3000/
sudo journalctl -u nodeguard.control.service -n 50 --no-pager
```

برای آزمایش محلی در حالت simulation می‌توانید از مرورگر روی همان میزبان استفاده کنید. برای راه‌اندازی HTTPS، پراکسی را روی نشانی عمومی تنظیم کنید و مسیرهای داشبورد و `/api/v1/` را به loopback بفرستید. ورود از مرورگر و دریافت بستهٔ Agent را از نشانی عمومی بررسی کنید.

## Workerهای مرکزی

هر Worker جداگانه فعال می‌شود. برای هر مورد، فایل `/etc/nodeguard/control-plane/workers/<instance>.env` را با مالک `root:root` و دسترسی `0600` بسازید. فقط خط توکن مربوط به همان نمونه را در فایل قرار دهید. systemd فایل هر نمونه را به همان حساب پویای سرویس تحویل می‌دهد. [اعتبارنامه‌های systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#LoadCredential=ID:PATH)

| نمونه | شرط فعال‌سازی در `control.env` | متغیر توکن در فایل Worker |
| --- | --- | --- |
| `health` | `NODEGUARD_ENABLE_HEALTH_MONITOR=1` | `NODEGUARD_HEALTH_WORKER_TOKEN` |
| `dns` | `NODEGUARD_ENABLE_DNS_MONITOR=1` و تنظیم اتصال خواندنی DNS | `NODEGUARD_DNS_WORKER_TOKEN` |
| `v2board` | `NODEGUARD_ENABLE_V2BOARD_MONITOR=1` و تنظیم اتصال خواندنی V2Board | `NODEGUARD_V2BOARD_WORKER_TOKEN` |
| `telegram` | `NODEGUARD_ENABLE_TELEGRAM=1` و تنظیم بات و مقصد | `NODEGUARD_TELEGRAM_WORKER_TOKEN` |
| `failover` | `NODEGUARD_ENABLE_DNS_FAILOVER=1` و ثبت رکوردهای مجاز و اتصال نوشتنی DNS | `NODEGUARD_FAILOVER_WORKER_TOKEN` |

توکن‌های `health`، `dns` و `v2board` باید ۶۴ رقم hex تصادفی و مستقل باشند. مقدار هرکدام را هم در `control.env` و هم در فایل همان Worker قرار دهید. Telegram از توکن حساب دارای `settings.edit` و Failover از توکن حساب دارای `failover.run` و `dns.switch` استفاده می‌کند. تعریف این حساب‌ها در `NODEGUARD_USER_TOKENS` است. اجرای خودکار Failover پرچم جداگانهٔ `NODEGUARD_ENABLE_AUTO_FAILOVER` و سیاست فعال نود را لازم دارد.

مثال راه‌اندازی Worker سلامت پس از آماده‌کردن `health.env` و تنظیم محیط `monitor`.

```sh
sudo systemd-analyze verify nodeguard.worker@health.service
sudo systemctl restart nodeguard.control.service
sudo systemctl enable --now nodeguard.worker@health.service
sudo journalctl -u nodeguard.worker@health.service -n 50 --no-pager
```

برای تغییر فایل توکن یک Worker، همان نمونه را بازراه‌اندازی کنید. اگر مقدار متناظر در `control.env` هم تغییر کرده، کنترل‌پلین را بازراه‌اندازی کنید تا Workerهای در حال اجرا نیز اعتبارنامه‌های تازه را بخوانند. برای توقف یک Worker، مثلاً از `sudo systemctl disable --now nodeguard.worker@health.service` استفاده کنید.

## استقرار و پایش با Agent

در کنترل‌پلین `NODEGUARD_ENABLE_SSH_INSTALL=1`، `NODEGUARD_ENABLE_PROVISION=1`، نشانی عمومی HTTPS در `NODEGUARD_ORIGIN` و کلید ثابت `NODEGUARD_CREDENTIAL_KEY` را تنظیم کنید. هر سرور را ثبت کنید، از جزئیات همان سرور اتصال SSH را ثبت و اثرانگشت میزبان را تأیید کنید، سپس «نصب NodeGuard Agent» را بزنید. برای ارتقای Agentهای موجود هم از همین دکمه استفاده کنید. Worker نصب پس از ثبت، با اعتبارنامهٔ میزبان به پنل متصل می‌شود.

از صفحهٔ نودها می‌توان استقرار یا اتصال V2bX را ثبت کرد. Agent شناسه و نوع نود، نشانی و کلید پنل را در سرویس‌های فعال بررسی می‌کند. اگر تنظیمات منطبق باشند، دسترسی به API نود را از همان میزبان امتحان می‌کند و سرویس موجود را حفظ می‌کند. نصب جدید روی میزبان دارای ترافیک فعال به پنجرهٔ نگهداری نیاز دارد.

در رکورد تونل از «استقرار با Agent» استفاده کنید. پنل بسته را با آدرس‌ها و پورت فعلی نود می‌سازد. هر Agent فقط فایل‌های کار واگذارشده به خودش را تا پایان مهلت آن دریافت می‌کند. فایل‌ها زیر `provision-artifacts` کنار فایل SQLite نگهداری می‌شوند و دایرکتوری باید فقط در اختیار کاربر سرویس کنترل‌پلین باشد. برای WireGuard پورت UDP دو سمت را وارد کنید. برای GOST مستقل، Agent خارج پاسخ‌گویی پورت مقصد را بررسی می‌کند و Agent ایران هدایت را نصب می‌کند. کاوش TCP نصب شامل اتصال به پورت مقصد و بررسی شنوندهٔ GOST است.

کاوش ICMP به `iputils-ping`، رابط‌ها به `iproute2` و WireGuard به `wireguard-tools` روی میزبان نیاز دارند. مسیر Geneve از UDP 6081 استفاده می‌کند. برای بسته‌های سفارشی Backhaul و Rathole ابتدا `enrollment.json` را در کاتالوگ ثبت کنید و در پیش‌نمایش هر پروفایل، فایل‌های همان سمت را همراه `manifest.json` بارگذاری کنید. Worker فایل‌ها را از پنل می‌گیرد. تاریخچهٔ ترافیک سرویس‌های هدایت مستقل به شمارنده‌های IPAccounting در systemd نیاز دارد.

در تنظیمات پایش برای CPU، RAM، دیسک، ترافیک، کاوش‌های تونل و لاگ‌ها بازهٔ جداگانه تعیین کنید. پینگ دوره‌ای سرور از Agent به نشانی پنل انجام می‌شود. پینگ از پنل، پینگ CheckHost و پینگ دستی IP داخلی تونل کاوش‌های جداگانه‌اند. حالت پایش به Agent دارای گزارش زمان‌بندی‌شده نیاز دارد. برای مهاجرت مرحله‌ای می‌توان موقتاً `NODEGUARD_ALLOW_LEGACY_TELEMETRY=1` را قبل از ذخیرهٔ بازه‌ها فعال کرد.

در تنظیمات اعلان برای هر سنجه قانون و فاصلهٔ تکرار تعریف کنید. Worker تلگرام و تنظیمات بات را برای تحویل تلگرام فعال کنید. برای Gmail، Worker `health`، دسترسی شبکه به `smtp.gmail.com:465` و رمز برنامهٔ حساب را تنظیم کنید. پنل رمز برنامه را رمزنگاری می‌کند. وضعیت تلاش تحویل ایمیل در تنظیمات Gmail نمایش داده می‌شود. [راهنمای رمز برنامهٔ Google](https://support.google.com/accounts/answer/185833)

مراحل پذیرش عملیاتی روی canary در [طرح کنترل عملیاتی](../../docs/control-plane.md#شرط-پذیرش-عملیاتی) آمده‌اند. Workerهای iperf3 و Provision از بستهٔ نصب Agent روی میزبان‌های تحت پایش راه‌اندازی می‌شوند.
