/* ============================================================
   Baseline — live data file
   ------------------------------------------------------------
   This is the ONE file to edit when models, prices, or book
   recommendations change. The page reads from here and stamps
   each card with its "as of" date + source. You do NOT touch
   index.html to update facts.

   How to update a card:
     1. Replace `html` with the current content.
     2. Set `asOf` to the date you checked it: "YYYY-MM-DD".
     3. Set `source` / `sourceUrl` to where you verified it.

   Rules the page enforces automatically:
     • asOf empty            -> amber "Needs live check" (placeholder)
     • asOf older than 120d  -> amber "May be outdated — re-check"
     • asOf recent           -> quiet grey "Verified <date>" + source link

   Leaving asOf empty is honest, not broken. Better a flagged
   blank than a confident wrong price.
   ============================================================ */

window.BASELINE_DATA = {

  /* Topic 3 & 4 — which models exist, and which to use for what */
  models: {
    asOf: "2026-07-21",
    source: "Vendor sites · live landscape",
    sourceUrl: "https://artificialanalysis.ai/models",
    // We list by PRODUCT name (stable) not version number (churns monthly).
    html: `
      <p>There are many models — some free, some paid, some open-source you can run yourself.
         More expensive is <strong>not</strong> always better for <em>your</em> task.</p>
      <p><strong>Rule of thumb:</strong> reach for a big flagship model for hard reasoning,
         coding and nuance; use a smaller/cheaper one for quick, high-volume, simple jobs.</p>
      <p style="opacity:.8">These are the main families as of mid-2026. Exact version numbers change
         almost monthly — the products below don't. Start with a paid one; try an open one later.</p>`,
    // { name, kind: "Paid"|"Open weight", best }
    list: [
      {name:"ChatGPT", kind:"Paid · OpenAI", best:"Strong all-rounder for everyday writing, research and coding."},
      {name:"Claude", kind:"Paid · Anthropic", best:"Great for careful writing and coding where accuracy matters."},
      {name:"Gemini", kind:"Paid · Google", best:"Good all-rounder, ties into Google apps, handles very long documents."},
      {name:"Grok", kind:"Paid · xAI", best:"Chat assistant with live access to the current web and X posts."},
      {name:"Llama", kind:"Open weight · USA", best:"Meta's model — free to download and run yourself; solid general-purpose chat."},
      {name:"Qwen", kind:"Open weight · China", best:"Alibaba's model — free, well-rounded, strong at coding and 100+ languages."},
      {name:"DeepSeek", kind:"Open weight · China", best:"Free, especially good at step-by-step reasoning and math."},
      {name:"Mistral", kind:"Open weight · France", best:"European model you can self-host with no per-use fees."}
    ]
  },

  /* Topic 6 — setup & what it costs, closed vs open weight */
  pricing: {
    asOf: "2026-07-21",
    source: "Vendor pricing pages (e.g. Claude's)",
    sourceUrl: "https://claude.com/pricing",
    html: `
      <p><strong>Closed / paid:</strong> sign up, usually a free tier plus a monthly plan.
         No setup — it works in a browser or app straight away.</p>
      <p><strong>Open weight:</strong> the model is free to download, but <em>you</em> pay in
         hardware, setup time, and electricity to run it.</p>
      <p style="opacity:.8">Rough bands below (exact prices drift, so we don't pin decimals):</p>`,
    // { plan, cost, notes }
    list: [
      {plan:"Free tier", cost:"$0", notes:"Every major tool (ChatGPT, Claude, Gemini) has one, with tighter daily limits."},
      {plan:"Typical paid plan", cost:"~$20/mo", notes:"ChatGPT Plus, Claude Pro, Google AI Pro — full access, higher limits. The usual pick."},
      {plan:"Power-user tier", cost:"~$100–200/mo", notes:"ChatGPT Pro, Claude Max, Google AI Ultra — only if you hit the paid limits daily."},
      {plan:"Run open-weight yourself", cost:"$0 licence", notes:"No per-use fee, but you need a capable computer and pay for its power."}
    ]
  },

  /* Topic 12 — books & classes worth taking */
  books: {
    asOf: "2026-07-21",
    // deliberate: no single section URL — every title above links to its own
    // publisher/author page, which ARE the sources.
    source: "Publisher & author pages — linked on each title",
    sourceUrl: "",
    html: `
      <p>Look for material that teaches <strong>how these systems actually work and where they
         fail</strong> — not just prompt tricks that expire.</p>
      <p>Separate <em>timeless fundamentals</em> (how models learn, why they hallucinate) from
         <em>this month's tool guide</em> (which button to click). The first ages well; the second doesn't.
         These are ordered gentlest first:</p>`,
    list: [
      {title:"You Look Like a Thing and I Love You", author:"Janelle Shane", kind:"Book",
       why:"Gentlest start: funny, no math — why AI 'thinks' weirdly and makes mistakes.",
       url:"https://www.janelleshane.com/book-you-look-like-a-thing"},
      {title:"Artificial Intelligence: A Guide for Thinking Humans", author:"Melanie Mitchell", kind:"Book",
       why:"Clear, hype-free tour of what AI really can and can't do. Fundamentals that age well.",
       url:"https://melaniemitchell.me/aibook/"},
      {title:"AI for Everyone", author:"Andrew Ng · DeepLearning.AI", kind:"Course",
       why:"Trusted no-background course (free to audit): what AI is, its limits and ethics.",
       url:"https://www.coursera.org/learn/ai-for-everyone"},
      {title:"Elements of AI", author:"University of Helsinki & MinnaLearn", kind:"Course",
       why:"Free, self-paced, no math or coding — built for ordinary citizens. 2M+ learners.",
       url:"https://www.elementsofai.com/"},
      {title:"Co-Intelligence: Living and Working with AI", author:"Ethan Mollick", kind:"Book",
       why:"Practical, day-to-day use of AI. Readable, but a bit more time-bound than the rest.",
       url:"https://www.penguinrandomhouse.com/books/741805/co-intelligence-by-ethan-mollick/"},
      {title:"The Alignment Problem", author:"Brian Christian", kind:"Book",
       why:"Deeper: why it's hard to make AI do what we intend, and where bias comes from.",
       url:"https://brianchristian.org/the-alignment-problem/"},
      {title:"What Is ChatGPT Doing … and Why Does It Work?", author:"Stephen Wolfram", kind:"Book",
       why:"Deepest, but short and free online: how a model actually predicts words under the hood.",
       url:"https://writings.stephenwolfram.com/2023/02/what-is-chatgpt-doing-and-why-does-it-work/"}
    ]
  }

};
