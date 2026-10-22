# Secure phone and tablet access

HexiGrid keeps ordinary desktop use on `http://127.0.0.1` because loopback traffic never leaves the computer. Network mode is different: it exposes the local service to other devices, so HexiGrid refuses to start it without HTTPS.

## Certificate requirements

Use a certificate that:

- is trusted by every device that will open HexiGrid;
- includes the exact local DNS name or IP address used in the browser;
- has a private key readable only by the operating-system account running HexiGrid;
- is renewed before it expires.

A certificate created by a private home certificate authority is a no-cost option. Install only that authority's public certificate on each device. Never copy the server private key to a phone or tablet.

## PFX configuration

```powershell
$env:HEXIGRID_TLS_PFX = "C:\private\hexigrid-lan.pfx"
$env:HEXIGRID_TLS_PASSPHRASE = Read-Host "Certificate passphrase"
.\Start-Control-Room.ps1 -Network
```

## PEM configuration

```powershell
$env:HEXIGRID_TLS_CERT = "C:\private\hexigrid-lan.crt"
$env:HEXIGRID_TLS_KEY = "C:\private\hexigrid-lan.key"
$env:HEXIGRID_TLS_PASSPHRASE = Read-Host "Private-key passphrase"
.\Start-Control-Room.ps1 -Network
```

The passphrase exists only in the server process environment. Certificate files and passphrases are excluded by the repository ignore rules and must never be placed inside a public repository.

After startup, open HexiGrid on the computer, go to **Connections**, and copy the HTTPS address and one-time pairing code. A browser certificate warning means the device does not trust the certificate; do not bypass the warning. Install the public certificate authority correctly or use a certificate issued by a trusted authority.

Network mode sets session, pairing, OAuth, and anti-forgery cookies with the `Secure` attribute and sends HTTP Strict Transport Security. Closing HexiGrid invalidates its in-memory sessions and pairing token.
