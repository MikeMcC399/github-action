# certs

Self-signed certificate for `localhost`, used by `vite.config-https.js`. Regenerate with:

```sh
openssl req -x509 -newkey rsa:2048 -keyout localhost-key.pem -out localhost-cert.pem \
  -days 3650 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
