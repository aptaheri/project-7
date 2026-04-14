import './About.scss'

const STAGES = [
  {
    label: 'Stage 1 & 1a',
    region: 'Europe & Central Asia',
    route: 'Praia do Guincho → Baku → Bishkek',
    detail: 'From the Atlantic coast of Portugal, east across the Iberian Peninsula, through the Balkans, Turkey, the Caucasus, and deep into the steppes of Kazakhstan and Kyrgyzstan.',
  },
  {
    label: 'Stage 2',
    region: 'Australia',
    route: 'Perth → Sydney',
    detail: 'A crossing of the Australian continent, west to east, through the Nullarbor Plain and along the southern coast before climbing into New South Wales.',
  },
  {
    label: 'Stage 3',
    region: 'South America',
    route: 'Manta → Rio de Janeiro',
    detail: 'Beginning on the Pacific coast of Ecuador, south through Peru and Bolivia, crossing the Andes and descending into Brazil to finish on the shores of Rio de Janeiro.',
  },
  {
    label: 'Stage 4',
    region: 'Africa',
    route: 'West Africa → Nyali Beach, Mombasa',
    detail: 'A traverse of the African continent, moving east across the Sahel and equatorial regions, finishing on the Indian Ocean coast of Kenya.',
  },
  {
    label: 'Stage 5',
    region: 'Asia',
    route: 'Mumbai → Wenzhou',
    detail: 'From the west coast of India, northeast through the subcontinent, across the Himalayas and into China, finishing on the Pacific coast.',
  },
  {
    label: 'Stage 6',
    region: 'North America',
    route: 'Santa Monica → New York',
    detail: 'Coast to coast across the United States, from the Pacific shore at Santa Monica Pier to the East River in New York City.',
  },
  {
    label: 'Stage 7',
    region: 'Antarctica',
    route: 'Antarctic traverse',
    detail: 'The final and most extreme stage — a human-powered crossing of Antarctica, completing the seven-continent journey.',
  },
]

export default function About() {
  return (
    <div className="about">
      <div className="about-content">
        <section className="about-hero">
          <p className="about-overline">The Expedition</p>
          <h1>Seven continents.<br />One road bike.</h1>
          <p className="about-lead">
            Project 7 is a friend's attempt to become the first person to cycle
            across all seven continents — riding every kilometre on a road bike,
            without the aid of a motor.
          </p>
        </section>

        <section className="about-section">
          <h2>The Mission</h2>
          <p>
            The concept is straightforward: cross every continent by bike. 99%
            of the route is on a road bike — through cities, deserts, mountain
            passes, and plains. On the rare occasions where geography makes
            riding impossible, he may need to row or swim a short section, but
            these are the exception, not the rule.
          </p>
          <p>
            The journey spans roughly 50,000 km across seven continents. Each
            stage has its own character: the endless flats of Central Asia, the
            heat of the Nullarbor, altitude in the Andes, and the brutal cold
            of Antarctica.
          </p>
        </section>

        <section className="about-section">
          <h2>The Route</h2>
          <div className="about-stages">
            {STAGES.map((s) => (
              <div key={s.label} className="about-stage">
                <div className="about-stage-header">
                  <span className="about-stage-label">{s.label}</span>
                  <span className="about-stage-region">{s.region}</span>
                </div>
                <p className="about-stage-route">{s.route}</p>
                <p className="about-stage-detail">{s.detail}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
