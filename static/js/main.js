// Event Logger - Real-time Event Display
let events = [];
let autoRefresh = true;
let refreshInterval = null;

// Initialize the application
function init() {
    setupEventListeners();
    loadEvents();
    startAutoRefresh();
}

// Set up event listeners
function setupEventListeners() {
    const refreshBtn = document.getElementById('refresh-btn');
    const autoRefreshToggle = document.getElementById('auto-refresh');
    const clearBtn = document.getElementById('clear-view-btn');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadEvents);
    }

    if (autoRefreshToggle) {
        autoRefreshToggle.addEventListener('change', (e) => {
            autoRefresh = e.target.checked;
            if (autoRefresh) {
                startAutoRefresh();
            } else {
                stopAutoRefresh();
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', clearView);
    }
}

// Load events from the API
async function loadEvents() {
    try {
        const response = await fetch('/api/events?limit=100');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        events = data.events || [];

        updateEventCount(data.total || 0);
        renderEvents();
    } catch (error) {
        console.error('Error loading events:', error);
        showError(`Failed to load events: ${error.message}`);
    }
}

// Render events to the DOM
function renderEvents() {
    const container = document.getElementById('events-container');
    if (!container) return;

    if (events.length === 0) {
        container.innerHTML = `
            <div class="no-events">
                <div class="no-events-icon">📭</div>
                <h3>No events yet</h3>
                <p>Events sent to /api/events will appear here in real-time</p>
            </div>
        `;
        return;
    }

    const eventsHtml = events.map(event => createEventCard(event)).join('');
    container.innerHTML = eventsHtml;
}

// Create an event card HTML
function createEventCard(event) {
    const timestamp = new Date(event.timestamp).toLocaleString();
    const payloadJson = JSON.stringify(event.payload, null, 2);

    return `
        <div class="event-card" data-event-id="${event.id}">
            <div class="event-header">
                <div class="event-id">Event #${event.id}</div>
                <div class="event-timestamp">${timestamp}</div>
            </div>
            <div class="event-payload">
                <pre><code>${escapeHtml(payloadJson)}</code></pre>
            </div>
        </div>
    `;
}

// Update event count display
function updateEventCount(count) {
    const countElement = document.getElementById('event-count');
    if (countElement) {
        countElement.textContent = count;
    }
}

// Clear the view (doesn't delete from database)
function clearView() {
    events = [];
    renderEvents();
    updateEventCount(0);
}

// Show error message
function showError(message) {
    const container = document.getElementById('events-container');
    if (container) {
        container.innerHTML = `
            <div class="error-message">
                <strong>Error:</strong> ${escapeHtml(message)}
            </div>
        `;
    }
}

// Start auto-refresh
function startAutoRefresh() {
    if (refreshInterval) return;

    refreshInterval = setInterval(() => {
        if (autoRefresh) {
            loadEvents();
        }
    }, 3000); // Refresh every 3 seconds
}

// Stop auto-refresh
function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);

console.log('Event Logger initialized');
