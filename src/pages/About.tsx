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

const RULES = [
  'Crossing a continent officially begins with a back tire dip in one ocean and ends with a front tire dip in the other ocean (or sea).',
  'Between tire dips, every point of longitude must be crossed under human power (cycling, walking, rowing, swimming). No hitching rides, no hanging onto backs of trucks, etc. No motors, no sails, and no animals.',
  'In emergency situations, hitching a ride is allowed, but returning to the exact pickup location to resume is required.',
  'Biking with others is allowed, but drafting directly behind them is not.',
  'To make it one continuous trip, no more than two-week breaks in one location are allowed.',
]

export default function About() {
  return (
    <div className="about">
      <div className="about-content">
        <section className="about-hero">
          <p className="about-overline">The Expedition</p>
          <h1>Seven continents.<br />On a bike.</h1>
          <p className="about-lead">
            If Project 7 is completed, it will be the first human-powered
            expedition of any kind across all seven continents. The journey
            starts in Europe, then continues in Australia, South America,
            Africa, Asia, North America, and finally ends in Antarctica. The
            33,000-mile route goes through 44 countries over 77 weeks. Each
            stage has its own character: the endless flats of Central Asia, the
            heat of the Nullarbor, altitude in the Andes, and the brutal cold
            of Antarctica.
          </p>
        </section>

        <section className="about-section">
          <h2>The Rules</h2>
          <ol className="about-rules">
            {RULES.map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ol>
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
