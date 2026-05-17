# KCl Landing Page

Site web officiel de [KCl](https://kcl-app.com) — outil d'optimisation PC pour gamers francophones.

## Stack

Site 100% statique (HTML + Tailwind CSS via CDN). Aucun build, déploiement instantané sur Vercel.

## Structure

```
kcl-landing/
├── index.html              Accueil avec hero + features + pricing
├── about.html              À propos
├── privacy.html            Politique de confidentialité (RGPD/Loi 25)
├── terms.html              Conditions d'utilisation
├── contact.html            Page contact
├── favicon.svg             Logo KCl
├── vercel.json             Config Vercel (clean URLs)
└── blog/
    ├── index.html                          Liste blog
    ├── optimiser-windows-11-gaming.html
    ├── anti-cheat-safe-tweaks.html
    ├── valorant-fps-boost.html
    ├── cs2-optimisation-guide.html
    ├── windows-services-disable-gaming.html
    └── vbs-hvci-fps-impact.html
```

## Déploiement

Auto-deploy via Vercel à chaque push sur `main`.

URL prod : https://kcl-app.vercel.app

## Licence

© 2026 KCl. Tous droits réservés.
