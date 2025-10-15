export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-5xl font-extrabold tracking-tight">
        adhered<span className="align-top">.</span>
      </h1>
      <p className="mt-4 text-lg">Led by dis order.</p>

      <div className="mt-10 grid gap-6 md:grid-cols-3">
        <a href="/programs" className="rounded-2xl border p-6 hover:shadow">Programs</a>
        <a href="/writink" className="rounded-2xl border p-6 hover:shadow">WritInk</a>
        <a href="/audio" className="rounded-2xl border p-6 hover:shadow">Audio</a>
      </div>

      <footer className="mt-16 border-t pt-6 text-sm text-black/60">
        © {new Date().getFullYear()} adhered.
      </footer>
    </main>
  );
}
