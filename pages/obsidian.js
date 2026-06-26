const DEFAULT_VAULT = 'The Agency';

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeFile(file) {
  if (!file || typeof file !== 'string') return '';
  return file.replace(/^\/+/, '').replace(/\\/g, '/');
}

export async function getServerSideProps({ query }) {
  const vault = firstValue(query.vault) || DEFAULT_VAULT;
  const file = normalizeFile(firstValue(query.file));

  return {
    props: {
      vault,
      file,
      obsidianUrl: file
        ? `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`
        : '',
    },
  };
}

export default function ObsidianOpenPage({ vault, file, obsidianUrl }) {
  const title = file ? 'Open Obsidian note' : 'Missing Obsidian file';

  return (
    <main className="page">
      <section className="card">
        <p className="eyebrow">The Agency Vault</p>
        <h1>{title}</h1>
        {file ? (
          <>
            <p className="note">{file}</p>
            <a className="button" href={obsidianUrl}>Open in Obsidian</a>
            <p className="fallback">If it does not open automatically, tap the button.</p>
            <script
              dangerouslySetInnerHTML={{
                __html: `setTimeout(function(){ window.location.href = ${JSON.stringify(obsidianUrl)}; }, 250);`,
              }}
            />
          </>
        ) : (
          <p className="fallback">No file was provided. Add <code>?file=Path%2FNote.md</code> to the URL.</p>
        )}
      </section>
      <style jsx>{`
        .page {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: #070807;
          color: #f7ffe8;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .card {
          width: min(520px, 100%);
          border: 1px solid rgba(200, 230, 50, 0.35);
          border-radius: 18px;
          padding: 28px;
          background: linear-gradient(180deg, rgba(22, 26, 18, 0.96), rgba(8, 10, 7, 0.96));
          box-shadow: 0 0 40px rgba(200, 230, 50, 0.12);
        }
        .eyebrow {
          margin: 0 0 10px;
          color: #c8e632;
          font-size: 12px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        h1 {
          margin: 0 0 16px;
          font-size: 30px;
          line-height: 1.1;
        }
        .note {
          margin: 0 0 22px;
          color: #dbe6c4;
          overflow-wrap: anywhere;
          line-height: 1.5;
        }
        .button {
          display: block;
          width: 100%;
          box-sizing: border-box;
          border-radius: 12px;
          padding: 16px 18px;
          background: #c8e632;
          color: #111;
          font-weight: 800;
          text-align: center;
          text-decoration: none;
        }
        .fallback {
          margin: 18px 0 0;
          color: #aeb89c;
          line-height: 1.45;
        }
        code {
          color: #c8e632;
        }
      `}</style>
    </main>
  );
}
