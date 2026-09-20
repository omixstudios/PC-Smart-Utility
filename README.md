# PC Smart Utility

PC Smart Utility is a Windows desktop utility by **OMIX STUDIOS** for PC diagnostics, hardware and system information, health checks, network tools, cleanup, cybersecurity learning, QR/barcode utilities, quick links, notifications, and troubleshooting workflows.

## Product

- **Product:** PC Smart Utility
- **Publisher:** OMIX STUDIOS
- **Platform:** Windows
- **Technology:** Electron + JavaScript
- **Microsoft Store:** https://apps.microsoft.com/detail/9NW5DMR2XQ36
- **Launch:** April 14, 2026
- **Community:** Contributions and bug reports are welcome.

## Main capabilities

- Hardware and system information
- PC health monitoring and health score
- Network diagnostics and network toolkit
- PC cleanup / Auto-Clean
- Cybersecurity learning and quiz content
- Scheduled Windows notifications
- Smart QR and barcode tools
- Quick links
- Local analytics
- Windows troubleshooting shortcuts
- Update checking
- Windows installer and Microsoft Store packaging

## Development

Requirements:

- Windows
- Node.js
- npm

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm start
```

Build Windows installer:

```bash
npm run build
```

Build AppX:

```bash
npm run build-appx
```

Build portable version:

```bash
npm run build-portable
```

## Repository structure

```text
PC-Smart-Utility/
├── main.js
├── preload.js
├── protocol.js
├── mime.js
├── index.html
├── styles.css
├── package.json
├── build.bat
├── build/
└── src/
    ├── dashboard.js
    ├── hardware.js
    ├── health.js
    ├── network.js
    ├── network-toolkit.js
    ├── cleaner.js
    ├── cyber-learning.js
    ├── cyber-questions.js
    ├── smart-qr.js
    ├── quicklinks.js
    ├── analytics.js
    ├── updates.js
    ├── state.js
    ├── utils.js
    └── main-renderer.js
```

## Contributing

PC Smart Utility is maintained by OMIX STUDIOS. Community members can report bugs, suggest features, improve documentation, and submit code changes through GitHub pull requests.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## Commercial use

This repository is distributed under the **PolyForm Noncommercial License 1.0.0**.

Commercial use, commercial distribution, resale, or incorporation into a commercial product is not permitted under the repository license without separate permission from OMIX STUDIOS.

For commercial licensing enquiries, contact OMIX STUDIOS through the project channels.

## Security

Please do not publicly disclose security vulnerabilities in an issue. See [SECURITY.md](SECURITY.md).

## Recognition

PC Smart Utility is developed as part of the OMIX STUDIOS product portfolio. The project is intended to grow through public feedback, community contributions, and transparent development.

---

**© 2026 OMIX STUDIOS. All rights reserved except for rights expressly granted by the project license.**
