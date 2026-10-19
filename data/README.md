# Offline dictionaries

`fr-en.tsv`: French → English, one line per word form, sorted (read by `js/dictionary.js`):

    form<TAB>meaning|meaning        an item "@lemma" means "a form of lemma" (see its line)

Built from the English Wiktionary (dump of 2026-09-02) as extracted by
[kaikki.org](https://kaikki.org/dictionary/French/) (Wiktextract: Tatu Ylonen,
*Wiktextract: Wiktionary as Machine-Readable Structured Data*, LREC 2022).

Wiktionary content is available under the
[Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
licence; this file is a derived work under the same licence.

To rebuild it, download `kaikki.org-dictionary-French.jsonl` from kaikki.org into its own
folder and run (Windows PowerShell, about 15 seconds):

    powershell -ExecutionPolicy Bypass -File tools\build-dict.ps1 -In <path>\fr.jsonl -Out data\fr-en.tsv
