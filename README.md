# 🏦 ChatBankAssist — asystent obsługi klienta banku

[![Live Demo](https://img.shields.io/badge/Live%20Demo-online-2563eb?style=flat-square)](https://dolildev.github.io/ChatBankAssist/)
[![Deploy to GitHub Pages](https://github.com/DolilDev/ChatBankAssist/actions/workflows/deploy.yml/badge.svg)](https://github.com/DolilDev/ChatBankAssist/actions/workflows/deploy.yml)
[![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-f7df1e?style=flat-square&logo=javascript&logoColor=000)](#-użyte-technologie-i-dlaczego)
[![No backend](https://img.shields.io/badge/backend-none-16794c?style=flat-square)](#)

Chatbot obsługi klienta dla banku, który **działa w całości w przeglądarce** — bez backendu, bez Node.js, bez frameworków. Odpowiada na pytania na podstawie konfigurowalnej **bazy wiedzy** (FAQ), a opcjonalnie potrafi korzystać z modelu AI (Gemini / Claude / OpenAI) po podaniu własnego klucza API.

🔗 **Demo na żywo:** https://dolildev.github.io/ChatBankAssist/
🧪 **Szybki test z kluczem API:** https://dolildev.github.io/ChatBankAssist/demo.html

![Podgląd interfejsu asystenta](docs/preview.svg)

> _Powyżej: poglądowy makieta interfejsu. Po uruchomieniu demo zobaczysz prawdziwy czat ze streamingiem odpowiedzi._

---

## 🎯 Cel biznesowy

Banki obsługują tysiące powtarzalnych zapytań dziennie (otwieranie konta, czas przelewu, zastrzeżenie karty…). Ten projekt pokazuje, jak **odciążyć infolinię** lekkim asystentem 24/7, który:

- odpowiada natychmiast na najczęstsze pytania na podstawie zweryfikowanej bazy wiedzy,
- **eskaluje do konsultanta**, gdy nie zna pewnej odpowiedzi (zamiast zmyślać),
- nie wymaga infrastruktury serwerowej — hostuje się za darmo na GitHub Pages,
- może zostać podpięty pod dowolny model LLM bez zmian w kodzie.

To jednocześnie kompletny, produkcyjnie wyglądający przykład „static-first" — cała logika po stronie klienta, deployment w pełni zautomatyzowany.

---

## ✨ Funkcje

- 💬 **Interfejs czatu** z bańkami wiadomości (użytkownik po prawej, bot po lewej).
- ⌨️ **Streaming odpowiedzi** słowo po słowie (jak w ChatGPT) z migającym kursorem.
- ⏳ **Wskaźnik pisania** (animowane kropki) podczas generowania odpowiedzi.
- 📚 **Baza wiedzy** ładowana z `knowledge_base.json` — bot odpowiada na podstawie jej treści (26 wpisów FAQ).
- 🧑‍💼 **Eskalacja do konsultanta** z wyraźnym komunikatem i przyciskami kontaktu (telefon, e-mail), gdy brak pewnej odpowiedzi.
- 💾 **Historia czatu w sessionStorage** — po odświeżeniu strony rozmowa nie znika.
- 👍👎 **Ocena odpowiedzi** (thumbs up / down) pod każdą wiadomością bota.
- 🔢 **Licznik tokenów** — pokazuje zużycie tokenów w rozmowie (rzeczywiste w trybie API, szacowane lokalnie).
- 🌗 **Tryb ciemny / jasny** z przełącznikiem (zapamiętywany, respektuje ustawienia systemu).
- 🌍 **Wykrywanie języka** — gdy piszesz po angielsku, bot odpowiada po angielsku.
- 📋 **Podsumowanie rozmowy** — „Twoje pytania dotyczyły: przelewów, kart".
- 🔌 **Tryb API** — wybór dostawcy (Gemini / Claude / OpenAI) i własny klucz, przechowywany tylko w `sessionStorage`.
- 🚀 **CI/CD** — automatyczny deployment na GitHub Pages, minifikacja CSS/JS, walidacja bazy wiedzy i generowanie `sitemap.xml`.
- 📱 **Responsywność** i czysty, profesjonalny wygląd (granat / biel), bez zewnętrznych frameworków CSS.

---

## 🧠 Jak to działa

Bot ma dwa tryby:

1. **Tryb lokalny (domyślny, bez klucza)** — pytanie jest normalizowane (m.in. polskie znaki) i dopasowywane do wpisów `knowledge_base.json` metodą scoringu słów kluczowych. Jeśli żaden wpis nie przekroczy progu pewności — następuje eskalacja do konsultanta.
2. **Tryb API (opcjonalny, z kluczem)** — pytanie wraz z bazą wiedzy jako kontekstem trafia do wybranego modelu LLM, a odpowiedź jest streamowana token po tokenie. Model jest instruowany, by odpowiadać **wyłącznie na podstawie bazy wiedzy** i eskalować, gdy nie zna odpowiedzi.

---

## 💻 Uruchomienie lokalne

Aplikacja to statyczne pliki, ale `knowledge_base.json` jest wczytywany przez `fetch`, więc **otwarcie `index.html` z dysku (`file://`) nie zadziała**. Uruchom dowolny prosty serwer HTTP:

```bash
git clone https://github.com/DolilDev/ChatBankAssist.git
cd ChatBankAssist

# Python 3 (wbudowany, nic nie instalujesz)
python3 -m http.server 8000
```

Następnie otwórz **http://localhost:8000/** (lub `/demo.html`).

> Inne opcje serwera: `php -S localhost:8000`, rozszerzenie „Live Server" w VS Code itp.

---

## 🚀 Wdrożenie na GitHub Pages

Deployment jest w pełni zautomatyzowany przez GitHub Actions (`.github/workflows/deploy.yml`).

1. Wypchnij repozytorium na GitHub (gałąź `main`).
2. W repo: **Settings → Pages → Build and deployment → Source → „GitHub Actions"**.
3. Każdy push do `main` uruchamia workflow, który:
   - ✅ **waliduje** `knowledge_base.json` (poprawność JSON, min. 20 wpisów, wymagane pola),
   - 🗜️ **minifikuje** CSS (`csso`) i JS (`terser`),
   - 🗺️ **generuje** `sitemap.xml` oraz `robots.txt`,
   - 🌐 **publikuje** witrynę na GitHub Pages.

Po pierwszym udanym przebiegu strona będzie dostępna pod `https://<użytkownik>.github.io/<repozytorium>/`.

---

## 🔑 Darmowy klucz Gemini w 2 minuty

Gemini to **zalecany** dostawca, bo jako jedyny działa bezpośrednio z przeglądarki (patrz sekcja o CORS).

1. Wejdź na **[aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)**.
2. Zaloguj się kontem Google.
3. Kliknij **„Create API key"** (Utwórz klucz API).
4. **Skopiuj** wygenerowany klucz.
5. W aplikacji kliknij ikonę ⚙ (Ustawienia), wybierz **Gemini**, **wklej klucz** i zapisz. Gotowe!

Możesz też użyć strony [`demo.html`](https://dolildev.github.io/ChatBankAssist/demo.html), która ma pole na klucz od razu na wierzchu.

---

## 🔒 Dlaczego klucze nie są przechowywane w kodzie

**Klucz API nigdy nie trafia do repozytorium ani na żaden serwer.** Podajesz go dopiero w działającej aplikacji, a my zapisujemy go **wyłącznie w `sessionStorage` Twojej przeglądarki** — pamięci, która:

- jest dostępna tylko dla tej jednej karty i tej domeny,
- **znika z chwilą zamknięcia przeglądarki** (nie zostaje na dysku jak `localStorage`),
- nigdy nie jest wysyłana do nas — zapytania lecą bezpośrednio z Twojej przeglądarki do API dostawcy.

Klucz w kodzie źródłowym (zwłaszcza w publicznym repo na GitHub) zostałby natychmiast zindeksowany i wykradziony przez boty — to jeden z najczęstszych wycieków sekretów. Dlatego `.gitignore` blokuje pliki `.env`/`*.key`, a aplikacja z założenia nie ma backendu, który mógłby taki sekret przechować.

> ⚠️ **Uwaga o CORS:** **OpenAI** i **Anthropic Claude** zwykle **blokują zapytania bezpośrednio z przeglądarki** (polityka CORS) — bez własnego serwera proxy klucz tych dostawców najczęściej nie zadziała. Aplikacja wyświetla wtedy wyraźne ostrzeżenie i rekomenduje **Gemini**.

---

## 🛠️ Użyte technologie i dlaczego

| Technologia | Po co | Dlaczego właśnie ona |
|---|---|---|
| **Vanilla JS (ES2018+)** | cała logika aplikacji | zero zależności i kroku budowania — kod działa wprost w przeglądarce, łatwy do audytu |
| **HTML5 + CSS3 (zmienne CSS)** | UI, motywy, responsywność | natywne zmienne CSS dają tryb ciemny/jasny bez frameworka |
| **Fetch + ReadableStream (SSE)** | streaming odpowiedzi z API | strumieniowanie token po tokenie bez bibliotek |
| **`knowledge_base.json`** | źródło wiedzy bota | rozdzielenie treści od kodu — bazę edytuje się bez dotykania logiki |
| **GitHub Actions** | CI/CD | darmowy, natywny deployment na Pages + walidacja i minifikacja |
| **`terser` + `csso`** | minifikacja | mniejsze pliki na produkcji, źródła pozostają czytelne |
| **`jq`** | walidacja JSON w CI | szybka kontrola poprawności bazy przed publikacją |

Świadomie **nie użyto** Reacta/Vue, bundlerów ani frameworków CSS — celem było pokazanie, że kompletny, dopracowany produkt da się dostarczyć w czystych technologiach webowych.

---

## ❓ Przykładowe pytania do bota

Po polsku:

- „Jak otworzyć konto osobiste?"
- „Ile trwa przelew i kiedy dotrze do odbiorcy?"
- „Zgubiłem kartę — jak ją zablokować?"
- „Jak ustawić zlecenie stałe?"
- „Dostałem podejrzany SMS z banku, co robić?"
- „Jak złożyć reklamację i ile trwa jej rozpatrzenie?"
- „Pod jaki numer dzwonić, żeby zastrzec kartę w nocy?"

In English (bot odpowie po angielsku):

- „How do I open an account?"
- „How long does an international transfer take?"
- „How can I contact the bank?"

A także coś spoza bazy wiedzy (zobaczysz **eskalację do konsultanta**):

- „Jakie macie oprocentowanie kredytu hipotecznego na 30 lat?"

---

## 📁 Struktura plików

```
index.html              # główna aplikacja czatu
demo.html               # strona demo z polem na klucz API
style.css               # style (granat/biel, tryb ciemny, responsywność)
app.js                  # cała logika (rdzeń window.BankBot)
knowledge_base.json     # baza wiedzy FAQ (26 wpisów, PL + EN)
docs/preview.svg        # podgląd interfejsu (do README)
.github/workflows/
  └── deploy.yml         # CI/CD: walidacja → minifikacja → sitemap → deploy
.gitignore
README.md
```

> `sitemap.xml`, `robots.txt` oraz katalog `dist/` powstają automatycznie w trakcie deploymentu i nie są trzymane w repozytorium.

---

## 📄 Licencja

Projekt demonstracyjny. „Bank Przykładowy", dane kontaktowe i treści FAQ są fikcyjne i służą wyłącznie do prezentacji.
