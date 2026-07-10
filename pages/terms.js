import Link from 'next/link';

export default function Terms() {
  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 20px', fontFamily: 'sans-serif', lineHeight: 1.7 }}>
      <h1>Terms of Service</h1>
      <p><strong>The Mounting Man</strong> — Last updated: July 10, 2026</p>

      <h2>1. Services</h2>
      <p>The Mounting Man provides professional TV mounting and installation services in the Minneapolis, Houston, and Austin markets. By scheduling a service, you agree to these terms.</p>

      <h2>2. Scheduling &amp; Cancellations</h2>
      <p>Appointments may be rescheduled or cancelled with at least 24 hours notice. Late cancellations may be subject to a fee.</p>

      <h2>3. Pricing</h2>
      <p>All pricing is provided prior to service. Final charges reflect the agreed-upon scope of work.</p>

      <h2>4. Liability</h2>
      <p>The Mounting Man is fully insured. We are not liable for pre-existing structural conditions or manufacturer defects in mounts or televisions.</p>

      <h2>5. Social Media</h2>
      <p>We may post photos of completed installations to our social media accounts (TikTok, Instagram, Facebook, etc.) to showcase our work. Photos will not include personally identifiable information without consent.</p>

      <h2>6. Contact</h2>
      <p>Our handling of booking, payment, and advertising-measurement data is described in our <Link href="/privacy">Privacy Policy</Link>. Questions? Email us at <a href="mailto:mntvmounting@gmail.com">mntvmounting@gmail.com</a></p>
    </div>
  );
}
