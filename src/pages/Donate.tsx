import './Donate.scss'

const DONATE_URL = 'https://www.gofundme.com/f/support-marty-lyons-foundations-mission'

export default function Donate() {
  return (
    <div className="donate">
      <div className="donate-content">
        <section className="donate-hero">
          <p className="donate-overline">Support the Ride</p>
          <h1>Every kilometer<br />is for a kid.</h1>
          <p className="donate-lead">
            Project 7 rides in support of the Marty Lyons Foundation, which
            grants wishes to children aged 3 to 17 facing terminal or
            life-threatening illnesses. Every dollar raised goes to the
            foundation — not to the expedition.
          </p>
        </section>

        <section className="donate-action">
          <a
            className="donate-button"
            href={DONATE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Donate on GoFundMe
          </a>

          <div className="donate-qr">
            <img src="/donate-qr.svg" alt="QR code linking to the Project 7 GoFundMe page" />
            <p className="donate-qr-caption">Scan to donate</p>
          </div>
        </section>

        <section className="donate-section">
          <h2>Where the money goes</h2>
          <p>
            The Marty Lyons Foundation has granted thousands of wishes since
            1982, working with families across the United States. Donations made
            through the GoFundMe above are directed to the foundation.
          </p>
          <p>
            If you would rather share the campaign than give, the QR code above
            is made to be screenshotted, printed, or passed along.
          </p>
        </section>
      </div>
    </div>
  )
}
