# Orrery notices

Orrery is an original Matrix client. It is **not** a fork of Element Web and contains no Element Web
source code, assets or branding. It is built on these open-source components:

- **matrix-js-sdk** and **@matrix-org/matrix-sdk-crypto-wasm** (Apache-2.0, The Matrix.org Foundation),
  the same SDK and Rust end-to-end encryption implementation that Element uses.
- **React**, **zustand**, **marked**, **DOMPurify**, **highlight.js**, **matrix-encrypt-attachment**.
- **Transformers.js** (Apache-2.0, Hugging Face) and **ONNX Runtime Web** (MIT, Microsoft) for
  on-device speech recognition with **OpenAI Whisper** models (MIT).
- **Electron** (MIT) for the Windows desktop app.

Orrery is licensed under the GNU Affero General Public License v3.0 or later (see `LICENSE`).
Full third-party license texts are in `THIRD-PARTY-LICENSES.txt`, which `npm run licenses` generates.

"Matrix" is a trademark of The Matrix.org Foundation. "Element" is a trademark of New Vector Ltd.
Neither organisation endorses this project.
