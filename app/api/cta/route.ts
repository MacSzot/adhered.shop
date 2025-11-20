export async function POST(req: Request) {
  return new Response(
    JSON.stringify({ day_link: "https://adhered.shop/demo" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
