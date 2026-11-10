<div align="center">

# WebDL

**A Windows download manager for sites that limit you to one file per IP.**  
Paste a list, give every download its own SOCKS5 proxy, and only sit down when a captcha actually needs a person.

<br>

[![Electron](https://img.shields.io/badge/Electron-33-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-JavaScript-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![SOCKS5](https://img.shields.io/badge/Proxy-SOCKS5-111111?style=for-the-badge)](https://en.wikipedia.org/wiki/SOCKS)

<br>

<img src="https://skillicons.dev/icons?i=electron,nodejs,javascript,html,css,windows&perline=6" alt="Electron, Node.js, JavaScript, HTML, CSS, Windows" />

<br>

`queue` · `socks5` · `rapidgator` · `cloudflare turnstile` · `manual captcha`

</div>

---

## What it does

Rapidgator allows one free download per IP every 120 minutes, then stops you with a captcha. WebDL spreads a list of files across working SOCKS5 proxies so they can run together. The captcha stays in the background while Cloudflare verifies. The window opens only when you have to click the box or pick the pictures.

```text
links  →  working proxies  →  wait out the timer  →  captcha  →  Downloads\WebDL
```

---

## Features

| | |
| --- | --- |
| **Queue** | Paste one link or a whole list. **Start downloads** moves them into the queue and clears the box. While a run is active the button becomes **Add to queue**. Rows run together. One file does not wait for the captcha above it. |
| **Colors** | Yellow is in progress. Green is saved. Red is stopped or failed. |
| **Double-click** | Opens that row's captcha window so you can see where it is stuck. A saved row opens the file. |
| **Two proxy lists** | Left is untested. Right is working. Downloads use only the working list. |
| **One address** | Cloudflare keys off the IP, not the port. `1.2.3.4:1080` and `1.2.3.4:8080` count as the same proxy. |
| **120 minutes** | After a Rapidgator file **actually saves**, that address waits 120 minutes. A failed captcha does not start the timer. |
| **Tests** | **Test UnTested** checks the left list. **Test Working** rechecks the right list. Up to 512 at once, 3 second timeout, probe `1.1.1.1:443`. |
| **Forget** | **Forget failures** clears rejected addresses. **Forget working** clears the right-hand list. |

---

## Rapidgator

```mermaid
flowchart LR
  file[File page] --> timer[Wait the page timer]
  timer --> captcha[Hidden captcha]
  captcha --> box[Click the checkbox]
  box --> human{Pictures?}
  human -->|Yes| you[Window opens]
  human -->|No| send[Press Send]
  you --> send
  send --> save[Save the file]
```

1. Through that download's SOCKS5 proxy, open the file page and start Rapidgator's timer.
2. Wait the number of seconds the page publishes, usually 60 to 80.
3. Ask for the captcha link. If Rapidgator says the wait is not finished, keep asking.
4. Load `https://rapidgator.net/download/captcha` in a hidden window on the same proxy.
5. After Cloudflare's "Verifying…" wait, click the checkbox.
6. If the pictures appear, the window opens. You solve those and press **Send**.
7. If the check passes on its own, WebDL presses **Send** and **CLICK HERE TO DOWNLOAD** without showing the window.
8. The file is saved under `%UserProfile%\Downloads\WebDL`.

A proxy that cannot open the captcha, or that stays on "Verification failed," is removed. Every other port on that same IP goes with it, and the file starts over on the next address.

---

## Screen

```text
┌──────────────────────────────────────────────┐
│  Paste links                                 │
│  [ Start downloads ] [ Cancel ] [ Folder ]   │
├──────────────────────────────────────────────┤
│  Queue                                       │
│  yellow   downloading / captcha              │
│  green    saved                              │
│  red      stopped or failed                  │
├──────────────────────┬───────────────────────┤
│  Untested            │  Working              │
├──────────────────────┴───────────────────────┤
│  Fetch   Test UnTested   Test Working        │
│  Forget failures     Forget working          │
├──────────────────────────────────────────────┤
│  Live log                                    │
└──────────────────────────────────────────────┘
```

---

## Run

Install [Node.js](https://nodejs.org/), then:

```bash
cd %UserProfile%\Desktop\WebDL
npm install
npm start
```

Electron downloads its runtime on install. If `npm start` says Electron failed to install, run:

```bash
node node_modules/electron/install.js
npm start
```

Files land in:

```text
%UserProfile%\Downloads\WebDL
```

Proxy lists are remembered in Electron's user data folder as `proxies.json`:

```json
{
  "Untested": ["203.0.113.10:1080"],
  "Working": ["203.0.113.20:1080"],
  "Failed": ["203.0.113.30"],
  "RapidgatorReady": {
    "203.0.113.20": 1762819200000
  }
}
```

`Failed` stores the IP, not the port. `RapidgatorReady` is the time that address can download again.

---

## Project

```text
WebDL
├── main.js          window, queue, captcha, 120 minute rule
├── socks.js         SOCKS5 client and local HTTP bridge
├── proxies.js       fetch, parse, and test
├── rapidgator.js    timer, then captcha link
├── preload.js       bridge from the page to main
├── renderer.js      queue, lists, buttons
└── index.html       layout
```

The browser cannot be pointed straight at a SOCKS5 proxy reliably, so each captcha window uses a localhost HTTP proxy. That bridge opens the real SOCKS5 connection. The download and the captcha leave through the same address.

---

## Proxy lists

**Fetch free lists** pulls fresh SOCKS5 addresses and skips any IP you already have or have already rejected.

| Source | List |
| --- | --- |
| monosans | [socks5.txt](https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt) |
| Proxifly | [data.txt](https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt) |
| TheSpeedX | [socks5.txt](https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt) |
| ProxyScrape | [v4](https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&protocol=socks5) · [v2](https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all) |
| dpangestuw | [socks5_proxies.txt](https://raw.githubusercontent.com/dpangestuw/Free-Proxy/refs/heads/main/socks5_proxies.txt) |
| hookzof | [proxy.txt](https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt) |
| jetkai | [proxies-socks5.txt](https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt) |
| prxchk | [socks5.txt](https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt) |
| vakhov | [socks5.txt](https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt) |
| ShiftyTR | [socks5.txt](https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt) |
| rdavydov | [socks5.txt](https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks5.txt) |
| openproxylist | [SOCKS5_RAW.txt](https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt) |
| Anonym0usWork1221 | [socks5_proxies.txt](https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/socks5_proxies.txt) |
| zevtyardt | [socks5.txt](https://raw.githubusercontent.com/zevtyardt/proxy-list/main/socks5.txt) |
| ErcinDedeoglu | [socks5.txt](https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt) |

Paste your own with `host:port` or `socks5://host:port`. A login looks like `socks5://user:pass@host:port`.

---

## Good to know

Public proxies can see the site you contact. HTTPS still hides the file itself.

The proxy test only proves a proxy can open a connection. It does not prove Cloudflare will accept that address. Most free proxies still fail the captcha. WebDL drops those and continues the same file on the next IP.

Captcha pictures are not solved for you. The checkbox after Cloudflare's wait is clicked for you. The window is there when a person has to pick pictures or press **Send**.

<div align="center">

<br>

[![JavaScript](https://img.shields.io/badge/written_in-JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![No captcha solver](https://img.shields.io/badge/captcha-manual_pictures-orange?style=flat-square)](#rapidgator)
[![License](https://img.shields.io/badge/use-local_app-lightgrey?style=flat-square)](#run)

</div>
