export class PicoWebScraperWeb {
  async fetchFeaturedGames(page = 1) {
    const url = `https://www.lexaloffle.com/bbs/lister.php?use_hurl=1&cat=7&sub=2&mode=carts&orderby=featured&page=${page}`;
    return this.scrapeGames(url);
  }

  async fetchNewGames(page = 1) {
    const url = `https://www.lexaloffle.com/bbs/lister.php?use_hurl=1&cat=7&sub=2&mode=carts&orderby=ts&page=${page}`;
    return this.scrapeGames(url);
  }

  async fetchRandomGame() {
    const url =
      "https://www.lexaloffle.com/bbs/lister.php?use_hurl=1&cat=7&sub=2&mode=carts&orderby=random";
    return this.scrapeGames(url);
  }

  async searchGames(options) {
    const query = encodeURIComponent(options.query || "");
    const url = `https://www.lexaloffle.com/bbs/?mode=carts&cat=7&sub=0&orderby=ts&search=${query}`;
    return this.scrapeGames(url);
  }

  async scrapeGames(targetUrl) {
    try {
      // use corsproxy.io
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
      console.log(`🔎 [WebScraper] SEARCHING URL: ${targetUrl}`);

      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const html = await response.text();
      return { games: this.parseHTML(html) };
    } catch (e) {
      console.error("Web scrape failed", e);
      return { games: [] };
    }
  }

  parseHTML(html) {
    const games = [];
    const seenIds = new Set();

    // robust regex strategy:
    // 1. js array format: ['uid', id, `title`, "thumb"]
    // 2. img tag format: <img src="...">

    // js array regex
    // matches: [ '...', 12345, `Title`, "/path/to/pico8_kart.png"
    const jsRegex = /\[\s*'[^']+'\s*,\s*(\d+)\s*,\s*`([^`]+)`\s*,\s*"([^"]+)"/g;

    let match;
    while ((match = jsRegex.exec(html)) !== null) {
      const id = match[1];
      if (seenIds.has(id)) continue;

      let title = match[2].trim();
      let srcPath = match[3];

      // fallback title if empty
      if (!title) {
        title = id;
      }

      // filter for valid cart images
      if (srcPath.includes("pico8_") || srcPath.endsWith(".p8.png")) {
        this.addGame(games, seenIds, id, title, srcPath);
      }
    }

    // fallback: image tag regex
    if (games.length === 0) {
      const imgRegex =
        /<img[^>]+src=["']([^"']*(?:pico8_|cposts\/|\.p8\.png)[^"']+)["'][^>]*>/gi;
      while ((match = imgRegex.exec(html)) !== null) {
        const srcPath = match[1];

        // robust id extraction
        let id = "";
        if (srcPath.includes("pico8_")) {
          id = srcPath.split("pico8_")[1].split(".")[0];
        } else {
          // handle 'cposts' or standard .p8.png files
          const filename = srcPath.split("/").pop();
          id = filename.replace(".p8.png", "").replace(".png", "");
        }

        if (id && !seenIds.has(id)) {
          // try to extract title, fallback to id if needed
          let title = "Unknown";
          // clean up filename to be a title
          if (srcPath.includes("/")) {
            const namePart = srcPath
              .split("/")
              .pop()
              .replace(".p8.png", "")
              .replace(".png", "");
            title = namePart.replace("pico8_", "").replace(/_/g, " ");
          }

          if (!title || title === "Unknown") {
            title = id;
          }

          this.addGame(games, seenIds, id, title, srcPath);
        }
      }
    }

    console.log(`✅ [WebScraper] Parsed ${games.length} games`);
    return games;
  }

  addGame(games, seenIds, id, title, srcPath) {
    seenIds.add(id);

    const fullThumbURL = srcPath.startsWith("http")
      ? srcPath
      : `https://www.lexaloffle.com${srcPath}`;

    // crucial: proxy the thumbnail for web
    const proxiedThumb = `https://corsproxy.io/?${encodeURIComponent(
      fullThumbURL
    )}`;

    // 1. construct the individual game page url for deep peek
    // use tid (thread id) instead of pid to ensure we get the main game player
    const gamePageURL = `https://www.lexaloffle.com/bbs/?tid=${id}`;
    const proxiedPageURL = `https://corsproxy.io/?${encodeURIComponent(
      gamePageURL
    )}`;

    // 2. construct fallback
    const idStr = String(id).toLowerCase();
    const subFolder = idStr.substring(0, 2);
    const binaryPath = `/bbs/cposts/${subFolder}/${idStr}.p8.png`;
    const fallbackURL = `https://www.lexaloffle.com${binaryPath}`;

    // note: download_url is now just a placeholder; logic happens in BBSExplorer
    const proxiedDownloadURL = `https://corsproxy.io/?${encodeURIComponent(
      fallbackURL
    )}`;

    const gameObj = {
      id: id,
      title: title || id, // final safety fallback
      author: "Unknown",
      thumb_url: proxiedThumb,
      source_page_url: proxiedPageURL, // peek this during download
      fallback_url: fallbackURL, // fail-safe direct link
      download_url: proxiedDownloadURL, // legacy support
    };

    games.push(gameObj);
  }

  // helper no longer needed as logic is inline, but keeping for reference if extended
  extractID(src) {
    if (src.includes("pico8_")) {
      return src.split("pico8_")[1].split(".")[0];
    } else {
      const filename = src.split("/").pop();
      if (!filename) return null;
      return filename.replace(".p8.png", "").replace(".png", "");
    }
  }
}
