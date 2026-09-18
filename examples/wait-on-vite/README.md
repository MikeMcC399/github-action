# example: wait-on-vite

This example confirms our action can wait for [Vite.js](https://vitejs.dev/) to respond.

The `vite.config-https.js` file is an alternate configuration that serves the app over https (via `npm run dev:https`), using the self-signed certificate committed in `certs/`.

To regenerate that certificate:

```sh
cd certs
openssl req -x509 -newkey rsa:2048 -keyout localhost-key.pem -out localhost-cert.pem \
  -days 3650 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Since the certificate is self-signed, clients must trust it explicitly. For Node.js-based tools
(such as this action's `wait-on` check), set `NODE_EXTRA_CA_CERTS` to the path of `certs/localhost-cert.pem`.
