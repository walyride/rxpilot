# RxPilot 💊✈️

**AI autopilot agent that reads handwritten prescriptions, catches dangerous drug interactions, and keeps the pharmacist in the loop.**

Built for the Global AI Hackathon Series with Qwen Cloud — Track 4: Autopilot Agent.

> Interaction rules clinically curated by a clinical pharmacy student — this is a real pharmacy workflow, not a toy demo.

## The Problem

Medication errors harm millions of patients every year. Handwritten prescriptions are still the norm in many countries, and dangerous drug interactions slip through busy pharmacy counters daily.

## What RxPilot Does

1. 📷 Reads a photo of a handwritten prescription (Arabic or English) using **Qwen-VL**
2. 🔎 Normalizes drug names to standard codes via **RxNorm**
3. ⚠️ Runs a safety engine: drug-drug interactions, dose range checks, patient allergy checks
4. 🧑‍⚕️ **Human-in-the-loop**: high-risk cases are blocked until a licensed pharmacist reviews and approves
5. 🏷️ Generates the dispensing label + patient counseling sheet in **Arabic**
6. 📜 Full audit log of every agent decision

## Architecture

*(Architecture diagram coming soon)*

- **Backend**: Node.js + Express, deployed on **Alibaba Cloud**
- **AI**: Qwen vision + text models via Qwen Cloud API
- **Drug data**: RxNorm + openFDA

## Quick Start

```bash
npm install
cp .env.example .env   # then paste your Qwen API key
npm run test:qwen      # verify Qwen connection
npm start              # run the server
```

## Status

🚧 Active development — hackathon submission in progress.

## License

MIT