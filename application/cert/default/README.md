# Generate certificates

## Certbot (for production)

- Let's Encrypt is a free certificate authority: https://letsencrypt.org/
- Use Certbot (free tool for automatically using Let’s Encrypt certificates on
  manually-administrated websites to enable HTTPS): https://certbot.eff.org/

```
dnf -y install certbot
certbot certonly --standalone -d www.xxii.chat -d xxii.chat -m timur@metarhia.com --agree-tos --no-eff-email
yes | cp /etc/letsencrypt/live/xxii.chat/fullchain.pem ~/xxii.chat/application/cert/cert.pem
yes | cp /etc/letsencrypt/live/xxii.chat/privkey.pem ~/xxii.chat/application/cert/key.pem
```

Or use impress web server for challenge exchange:

```
certbot certonly --webroot -w ~/xxii.chat/application/static -d www.xxii.chat -d xxii.chat -m timur@metarhia.com --agree-tos --no-eff-email
```

## Self-signed (for testing)

- Run `./generate.sh` in this directory
