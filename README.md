# simple-service-doc-converter

Simple API for document conversion using LibreOffice (`soffice`) via Bun (TypeScript).

This repository provides a minimal HTTP API that accepts a file (multipart/form-data) and returns the converted file (for example, docx -> pdf). Conversion is performed by invoking the `soffice` (LibreOffice) binary in headless mode inside a Docker container.

Key features

- HTTP server implemented for Bun (TypeScript)
- Endpoint: POST /convert (multipart/form-data)
- Real conversion using `soffice --headless --convert-to`
- Isolation via Docker / Docker Compose (image based on oven/bun:debian)
- Simple concurrency control using `p-limit` (environment variable CONCURRENCY_LIMIT)

## Contents

- `src/server.ts` - Bun server with POST `/convert` route
- `src/lib/convert.ts` - logic that writes a temporary file, runs `soffice`, and returns the result
- `src/common/class/FileTemp.ts` - utility for temporary files
- `Dockerfile` - image that installs Bun and LibreOffice
- `docker-compose.yml` - orchestration for running the service locally

## Requirements

- Docker & Docker Compose (to run in a container)
- Bun (optional, if you want to run locally without Docker)
- `soffice` (LibreOffice) — when running on the host without Docker

Note: running via Docker Compose is the recommended flow to ensure `soffice` is available and execution is isolated from the host.

## Environment variables

- `PORT` (default: 3000) — port where the server listens
- `CONCURRENCY_LIMIT` (default: 5) — limits concurrent conversions to protect the system

You can configure these variables in `docker-compose.yml` or in the environment before starting the application.

## How to run (production / server with Docker)

1. Build the image and bring up the service with Docker Compose:

```sh
docker compose up --build -d
```

2. Check logs (optional):

```sh
docker compose logs -f
```

3. Test the endpoint with curl (replace `test/test.docx` with your file):

```sh
curl -s -X POST "http://localhost:3000/convert" \
  -F "file=@test/test.docx" \
  -F "from=docx" \
  -F "to=pdf" \
  --output converted.pdf

# Inspect the header of the converted file
hexdump -C converted.pdf | head
```

If conversion fails, the service will return a response body containing diagnostic text (stdout/stderr from `soffice`).

## How to run locally (without Docker)

Note: running without Docker requires Bun and `soffice` installed on the host. Installing LibreOffice locally can be large on many systems.

1. Install dependencies (with Bun):

```sh
bun install
```

2. Start the server in development mode:

```sh
bun run src/server.ts
```

3. Make the same curl request shown in the previous section.

## HTTP tests with httpyac

A ready-to-use request file is included at `test/convert_request.http` for use with `httpyac`.

Example (generates `test/converted.pdf`):

```sh
# using httpyac (recommended to run from the project root)
httpyac send ./test/convert_request.http --output body --silent > ./test/converted.pdf
```

If `httpyac` prompts for interactive input (telemetry/config), run it in an environment where you can respond or preconfigure httpyac to skip prompts.

## API

POST /convert

- Body: multipart/form-data
  - `file` - file to be converted
  - `from` - source extension (e.g. `docx`)
  - `to` - target extension (e.g. `pdf`)

Successful response: binary content of the converted file with a `Content-Disposition` header suggesting a filename.

Error response: JSON or plain text with error details (for example, output from `soffice`).

Curl example:

```sh
curl -X POST "http://localhost:3000/convert" \
  -F "file=@path/to/file.docx" \
  -F "from=docx" \
  -F "to=pdf" \
  -o converted.pdf
```

## Operational notes and troubleshooting

- LibreOffice `soffice` often emits warnings related to Java (javaldx). These warnings do not necessarily indicate failure: the binary may write messages to stderr and still produce the converted file (exit code 0). The service attempts to read the output file even if there is text on stderr.
- If conversion fails and no file is produced, the service returns stdout/stderr to help diagnose the problem.
- In resource-constrained environments, increase `CONCURRENCY_LIMIT` with caution. If you receive many concurrent requests, consider using a persistent queue (Redis, RabbitMQ) and dedicated workers.
- Conversion of certain formats may depend on filters/plugins installed in LibreOffice. Test the formats your application needs in advance.

## Security

- Never execute untrusted files in a container with access to sensitive resources. Although the service is intended to run in an isolated container, be careful with malicious uploads.
- Consider limiting the maximum upload size at the server or reverse proxy (Nginx) and validating file extensions before processing.

## Production best practices

- Run the service in a container cluster (Kubernetes, ECS) and use a queuing system for long-running conversions.
- Use persistent storage for input/output files (S3, Azure Blob) instead of keeping everything on the container's local disk.
- Protect the endpoint with authentication (API keys, OAuth) and monitor usage to prevent abuse.

## Project structure

Main files:

- `src/server.ts` — Bun server entrypoint
- `src/lib/convert.ts` — conversion logic that invokes `soffice`
- `src/common/class/FileTemp.ts` — temporary file utility
- `Dockerfile` — base image and OS dependency installation
- `docker-compose.yml` — local orchestration

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.

```sh
curl -X POST "http://localhost:3000/convert" \
  -F "file=@path/to/file.docx" \
  -F "from=docx" \
  -F "to=pdf" \
  -o converted.pdf
```

## Operational notes and troubleshooting

- LibreOffice `soffice` often emits warnings related to Java (javaldx). These warnings do not necessarily indicate failure: the binary may write messages to stderr and still produce the converted file (exit code 0). The service attempts to read the output file even if there is text on stderr.
- If conversion fails and no file is produced, the service returns stdout/stderr to help diagnose the problem.
- In resource-constrained environments, increase `CONCURRENCY_LIMIT` with caution. If you receive many concurrent requests, consider using a persistent queue (Redis, RabbitMQ) and dedicated workers.
- Conversion of certain formats may depend on filters/plugins installed in LibreOffice. Test the formats your application needs in advance.

## Security

- Never execute untrusted files in a container with access to sensitive resources. Although the service is intended to run in an isolated container, be careful with malicious uploads.
- Consider limiting the maximum upload size at the server or reverse proxy (Nginx) and validating file extensions before processing.

## Production best practices

- Run the service in a container cluster (Kubernetes, ECS) and use a queuing system for long-running conversions.
- Use persistent storage for input/output files (S3, Azure Blob) instead of keeping everything on the container's local disk.
- Protect the endpoint with authentication (API keys, OAuth) and monitor usage to prevent abuse.

## Project structure

Main files:

- `src/server.ts` — Bun server entrypoint
- `src/lib/convert.ts` — conversion logic that invokes `soffice`
- `src/common/class/FileTemp.ts` — temporary file utility
- `Dockerfile` — base image and OS dependency installation
- `docker-compose.yml` — local orchestration

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
